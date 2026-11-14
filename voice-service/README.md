# voice-service

手机本地语音服务（跑在 proot Ubuntu 的 Python 3.12 里）。

- 唤醒词：Raven DTW 模板匹配（录 3–4 句即可，不训练）
- ASR：sherpa-onnx，本地 SenseVoice / zipformer，或 DeepSeek ASR
- 音频保存、历史、二次识别
- 默认 `127.0.0.1:3097`

## 启动

依赖已装在 proot 的 `/root/python312`。把 `app.py` 同步到 proot：

```sh
cp voice-service/app.py \
  /data/data/com.termux/files/usr/var/lib/proot-distro/installed-rootfs/ubuntu-noble/root/voice-service/app.py
```

前台启动（或交给 Termux 后台任务）：

```sh
proot-distro login ubuntu-noble -- \
  /root/python312/bin/python3.12 /root/voice-service/app.py
```

模型放在 proot 的 `/root/asr-models/`：

- `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/`
- `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/`

## 接口

- `GET /health`
- `POST /wake/enroll`（multipart，`files` 3–6 个 WAV，`wakeword`）
- `GET /wake/status`
- `POST /wake/score`（multipart `file`）
- `POST /asr`（multipart `file`，`model=sensevoice|zipformer|cloud`）
- `POST /rerecognize`（JSON `{id, model}`）
- `GET /history?limit=30`
- `GET /audio/{id}`
- `GET/PUT /config`

所有音频统一 16 kHz、16-bit、单声道。
