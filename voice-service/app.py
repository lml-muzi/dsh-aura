"""小满本地语音服务：唤醒词注册/打分 + ASR + 二次识别。

跑在 proot Ubuntu 的 Python 3.12 里（sherpa-onnx + Raven 依赖）。
默认端口 3097，只监听 127.0.0.1。
"""
import io, json, math, os, time, uuid, wave
from pathlib import Path
from typing import List, Optional

import httpx
import numpy as np
import scipy.io.wavfile
import python_speech_features
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from rhasspywake_raven.dtw import DynamicTimeWarping

import sherpa_onnx

ROOT = Path('/root/voice-data')
AUDIO_DIR = ROOT / 'audio'
ENROLL_DIR = ROOT / 'enroll'
for p in (ROOT, AUDIO_DIR, ENROLL_DIR):
    p.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = ROOT / 'config.json'
META_PATH = ROOT / 'audio.jsonl'
WAKE_PATH = ROOT / 'wake.npz'

ASR_MODELS = {
    'sensevoice': Path('/root/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'),
    'zipformer': Path('/root/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'),
}
DEFAULT_CONFIG = {
    'wakeword': '小满小满',
    'wakeEnabled': True,
    'wakeThreshold': 0.55,
    'wakeDistanceThreshold': 0.15,
    'wakeMinMatches': 2,
    'wakeCooldownMs': 2500,
    'continuousWindowMs': 30000,
    'asrModel': 'sensevoice',
    'rerecognizeModel': 'sensevoice',
    'saveAudio': True,
    'asrProvider': 'local',
    'cloudAsrEndpoint': 'https://api.deepseek.com/v1/tools/asr',
    'cloudAsrApiKey': '',
    'cloudTtsEndpoint': 'https://api.deepseek.com/v1/tools/tts',
    'cloudTtsApiKey': '',
    'cloudVoiceId': 'stella',
}
if CONFIG_PATH.exists():
    try:
        cfg = {**DEFAULT_CONFIG, **json.loads(CONFIG_PATH.read_text())}
    except Exception:
        cfg = dict(DEFAULT_CONFIG)
else:
    cfg = dict(DEFAULT_CONFIG)


def save_config():
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n')


def read_wav_bytes(data: bytes):
    with wave.open(io.BytesIO(data), 'rb') as f:
        sr = f.getframerate(); ch = f.getnchannels(); sw = f.getsampwidth(); n = f.getnframes()
        raw = f.readframes(n)
    if sw != 2:
        raise HTTPException(400, 'only 16-bit PCM WAV is supported')
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        ratio = sr / 16000
        length = max(1, int(len(x) / ratio))
        out = np.zeros(length, dtype=np.float32)
        for i in range(length):
            a = int(i * ratio); b = min(len(x), int((i + 1) * ratio))
            out[i] = x[a:b].mean() if b > a else x[min(len(x) - 1, a)]
        x = out
    return x


def trim_to_speech(x: np.ndarray, sample_rate: int = 16000, max_sec: float = 2.0):
    frame = int(sample_rate * 0.02)
    if len(x) < frame:
        return x
    frames = len(x) // frame
    energy = np.array([np.sqrt(np.mean(x[i * frame:(i + 1) * frame] ** 2) + 1e-12) for i in range(frames)])
    floor = np.percentile(energy, 10)
    threshold = max(floor * 3.0, 10 ** (-50 / 20))
    active = np.where(energy > threshold)[0]
    if len(active) == 0:
        return x[:int(sample_rate * 0.2)]
    start = max(0, (active[0] - 3) * frame)
    end = min(len(x), (active[-1] + 4) * frame)
    out = x[start:end]
    return out[:int(sample_rate * max_sec)]


def mfcc(x: np.ndarray):
    return python_speech_features.mfcc(x, 16000, winstep=0.02)


def dtw_distance(template, window, distance_threshold):
    dtw = DynamicTimeWarping()
    cost = dtw.compute_cost(template, window, 5, step_pattern=2)
    normalized = cost / (len(window) + len(template))
    probability = 1 / (1 + math.exp((normalized - distance_threshold) / distance_threshold))
    return normalized, probability


def load_wake_template():
    if not WAKE_PATH.exists():
        return None
    data = np.load(WAKE_PATH, allow_pickle=False)
    return {'mfcc': data['mfcc'], 'duration': float(data['duration'])}


def build_wake_template(wavs: List[np.ndarray]):
    arrays = [trim_to_speech(x) for x in wavs]
    templates = [mfcc(x) for x in arrays]
    # 用最长的模板做基准，其他模板 DTW 对齐后平均（和 Raven 一致）
    templates.sort(key=lambda m: len(m), reverse=True)
    base = templates[0]
    dtw = DynamicTimeWarping()
    averages = [[[float(base[r][c])] for c in range(base.shape[1])] for r in range(base.shape[0])]
    for tpl in templates[1:]:
        dtw.compute_cost(tpl, base, keep_matrix=True)
        path = dtw.compute_path()
        if not path:
            continue
        for row, col in path:
            for i, feature in enumerate(tpl[row]):
                averages[col][i].append(float(feature))
    avg = np.array([[np.mean(averages[r][c]) for c in range(base.shape[1])] for r in range(base.shape[0])], dtype=np.float32)
    np.savez(WAKE_PATH, mfcc=avg, duration=float(len(arrays[0]) / 16000))
    return {'mfcc': avg, 'duration': float(len(arrays[0]) / 16000)}


def score_wake(x: np.ndarray):
    tpl = load_wake_template()
    if tpl is None:
        return {'enrolled': False, 'probability': 0.0, 'distance': None, 'trigger': False}
    x = trim_to_speech(x, max_sec=6.0)
    feat = mfcc(x)
    tmpl = tpl['mfcc']
    width = len(tmpl)
    if len(feat) < width:
        return {'enrolled': True, 'probability': 0.0, 'distance': None, 'trigger': False}
    best = (1e9, 0.0)
    step = 2
    for start in range(0, len(feat) - width + 1, step):
        win = feat[start:start + width]
        d, p = dtw_distance(tmpl, win, float(cfg['wakeDistanceThreshold']))
        if d < best[0]:
            best = (d, p)
    distance, probability = best
    trigger = probability >= float(cfg['wakeThreshold']) and distance <= float(cfg['wakeDistanceThreshold'])
    return {'enrolled': True, 'probability': float(probability), 'distance': float(distance), 'trigger': bool(trigger)}


_asr = {}


def get_asr(model: str):
    if model not in ASR_MODELS or not ASR_MODELS[model].exists():
        raise HTTPException(400, f'asr model not available: {model}')
    if model in _asr:
        return _asr[model]
    if model == 'sensevoice':
        path = ASR_MODELS[model]
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(path / 'model.int8.onnx'), tokens=str(path / 'tokens.txt'),
            num_threads=2, use_itn=True, language='zh', debug=False, provider='cpu')
    else:
        path = ASR_MODELS[model]
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(path / 'tokens.txt'),
            encoder=str(path / 'encoder-epoch-99-avg-1.int8.onnx'),
            decoder=str(path / 'decoder-epoch-99-avg-1.int8.onnx'),
            joiner=str(path / 'joiner-epoch-99-avg-1.int8.onnx'),
            num_threads=2, sample_rate=16000, feature_dim=80, decoding_method='greedy_search', provider='cpu')
    _asr[model] = recognizer
    return recognizer


def wav_bytes(x: np.ndarray) -> bytes:
    import io as _io
    buf = _io.BytesIO()
    with wave.open(buf, 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
        f.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def transcribe_cloud(x: np.ndarray):
    key = str(cfg.get('cloudAsrApiKey') or '').strip()
    if not key:
        raise HTTPException(400, 'cloud ASR key missing')
    endpoint = str(cfg.get('cloudAsrEndpoint') or 'https://api.deepseek.com/v1/tools/asr')
    t0 = time.time()
    with httpx.Client(timeout=60) as client:
        r = client.post(endpoint, headers={'authorization': f'Bearer {key}'},
                        files={'file': ('audio.wav', wav_bytes(x), 'audio/wav')})
    if r.status_code != 200:
        raise HTTPException(502, f'cloud asr {r.status_code}: {r.text[:200]}')
    data = r.json()
    return str(data.get('text') or '').strip(), time.time() - t0


def transcribe(x: np.ndarray, model: str):
    if model == 'cloud':
        return transcribe_cloud(x)
    rec = get_asr(model)
    t0 = time.time()
    if model == 'sensevoice':
        stream = rec.create_stream(); stream.accept_waveform(16000, x); rec.decode_stream(stream)
        text = stream.result.text
    else:
        stream = rec.create_stream(); stream.accept_waveform(16000, x)
        stream.accept_waveform(16000, np.zeros(8000, dtype=np.float32))
        while rec.is_ready(stream):
            rec.decode_stream(stream)
        text = rec.get_result(stream)
    return str(text).strip(), time.time() - t0


def metadata_append(entry):
    with META_PATH.open('a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def metadata_find(audio_id):
    if not META_PATH.exists():
        return None
    for line in META_PATH.read_text(encoding='utf-8').splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get('id') == audio_id:
            return e
    return None


app = FastAPI(title='voice-service')


@app.get('/health')
def health():
    return {'ok': True, 'wakeEnrolled': WAKE_PATH.exists(), 'config': cfg, 'models': list(ASR_MODELS)}


@app.get('/config')
def get_config():
    return cfg


@app.put('/config')
def put_config(patch: dict):
    for k, v in (patch or {}).items():
        if k in DEFAULT_CONFIG:
            cfg[k] = v
    save_config()
    return cfg


@app.post('/wake/enroll')
async def wake_enroll(files: List[UploadFile] = File(...), wakeword: Optional[str] = Form(None)):
    if len(files) < 3:
        raise HTTPException(400, '至少需要 3 句注册音频')
    arrays = []
    for f in files[:6]:
        arrays.append(read_wav_bytes(await f.read()))
    if wakeword:
        cfg['wakeword'] = wakeword
        save_config()
    tpl = build_wake_template(arrays)
    return {'ok': True, 'samples': len(arrays), 'duration': tpl['duration'], 'wakeword': cfg['wakeword']}


@app.get('/wake/status')
def wake_status():
    tpl = load_wake_template()
    return {'enrolled': tpl is not None, 'wakeword': cfg['wakeword'], 'duration': tpl['duration'] if tpl else None,
            'threshold': cfg['wakeThreshold'], 'distanceThreshold': cfg['wakeDistanceThreshold']}


@app.post('/wake/score')
async def wake_score(file: UploadFile = File(...)):
    x = read_wav_bytes(await file.read())
    return score_wake(x)


@app.post('/asr')
async def asr(file: UploadFile = File(...), model: Optional[str] = Form(None), save: Optional[bool] = Form(True)):
    model = model or cfg['asrModel']
    x = read_wav_bytes(await file.read())
    text, elapsed = transcribe(x, model)
    audio_id = uuid.uuid4().hex[:12]
    saved = False
    if cfg['saveAudio'] and (save is None or save):
        path = AUDIO_DIR / f'{audio_id}.wav'
        with wave.open(str(path), 'wb') as f:
            f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
            f.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
        entry = {'id': audio_id, 'text': text, 'model': model, 'durationMs': round(len(x) / 16),
                 'createdAt': time.time(), 'peak': float(np.max(np.abs(x))), 'rms': float(np.sqrt(np.mean(x * x)))}
        metadata_append(entry); saved = True
    return {'ok': True, 'text': text, 'model': model, 'id': audio_id, 'saved': saved, 'asrMs': round(elapsed * 1000)}


@app.post('/rerecognize')
async def rerecognize(payload: dict):
    audio_id = payload.get('id')
    model = payload.get('model') or cfg['rerecognizeModel']
    entry = metadata_find(audio_id) if audio_id else None
    if not entry:
        raise HTTPException(404, 'audio not found')
    path = AUDIO_DIR / f'{audio_id}.wav'
    if not path.exists():
        raise HTTPException(404, 'wav missing')
    sr, data = scipy.io.wavfile.read(str(path))
    x = data.astype(np.float32) / 32768.0
    text, elapsed = transcribe(x, model)
    entry['rerecognized'] = {'model': model, 'text': text, 'asrMs': round(elapsed * 1000), 'at': time.time()}
    metadata_append(entry)
    return {'ok': True, **entry['rerecognized'], 'text': text, 'id': audio_id}


@app.get('/audio/{audio_id}')
def audio(audio_id: str):
    path = AUDIO_DIR / f'{audio_id}.wav'
    if not path.exists():
        raise HTTPException(404, 'not found')
    return FileResponse(str(path), media_type='audio/wav')


@app.get('/history')
def history(limit: int = 30):
    if not META_PATH.exists():
        return {'items': []}
    items = []
    for line in META_PATH.read_text(encoding='utf-8').splitlines():
        try:
            items.append(json.loads(line))
        except Exception:
            pass
    return {'items': items[-limit:][::-1]}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=3097, log_level='warning')
