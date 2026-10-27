#!/usr/bin/env node
/**
 * 客户端模块真实加载自测。
 *
 * 在 Node 里模拟 DSH 客户端的 window.__ModuleLoader__.load({ id, factory })，
 * 真正执行 client.js 的 factory 与 apply(fakeCtx)，而不是只做语法检查：
 *   - 能抓到模块声明；
 *   - factory 顶层执行不抛 ReferenceError（例如误用未初始化的常量）；
 *   - 返回的 { inject, apply } 形状正确；
 *   - apply 能完成槽位注册与 effect 初始化。
 *
 * 全程不联网、不起真实定时器、不碰 QQ：fetch 返回永不 settle 的 Promise，
 * setTimeout/setInterval 只记录不触发。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client.js')

const failures = []
const warnings = []
const clientErrors = []
const fetchCalls = []
const timers = []
const observers = []
const documentListeners = new Set()

function fail(stage, error) {
  console.error(`❌ 客户端加载自测失败：${stage}`)
  const detail = error && error.stack ? error.stack : String(error)
  console.error(detail)
  process.exit(1)
}

function check(condition, message) {
  if (!condition) failures.push(message)
}

/* ---------- 最小 DOM ---------- */

function makeElement(tag) {
  const attributes = new Map()
  const element = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    parentNode: null,
    parentElement: null,
    isConnected: false,
    textContent: '',
    innerHTML: '',
    className: '',
    id: '',
    src: '',
    alt: '',
    title: '',
    loading: '',
    decoding: '',
    value: '',
    hidden: false,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false },
      replace() {},
    },
    setAttribute(name, value) { attributes.set(String(name), String(value)) },
    getAttribute(name) { return attributes.has(String(name)) ? attributes.get(String(name)) : null },
    hasAttribute(name) { return attributes.has(String(name)) },
    removeAttribute(name) { attributes.delete(String(name)) },
    getAttributeNames() { return [...attributes.keys()] },
    appendChild(child) {
      if (!child) throw new TypeError(`appendChild(${tag}) 收到空节点`)
      child.parentNode = this
      child.parentElement = this.nodeType === 1 ? this : null
      this.children.push(child)
      this.childNodes.push(child)
      return child
    },
    insertBefore(child) { return this.appendChild(child) },
    replaceChild(next) { return next },
    removeChild(child) {
      const index = this.children.indexOf(child)
      if (index >= 0) this.children.splice(index, 1)
      const nodeIndex = this.childNodes.indexOf(child)
      if (nodeIndex >= 0) this.childNodes.splice(nodeIndex, 1)
      child.parentNode = null
      child.parentElement = null
      return child
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    addEventListener(type, listener) {
      const key = String(type)
      if (!this._listeners) this._listeners = new Map()
      if (!this._listeners.has(key)) this._listeners.set(key, new Set())
      this._listeners.get(key).add(listener)
    },
    removeEventListener(type, listener) {
      if (this._listeners) this._listeners.get(String(type))?.delete(listener)
    },
    dispatchEvent() { return true },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
    contains() { return false },
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }
    },
    getClientRects() { return [] },
    getContext() { return null },
    setPointerCapture() {},
    releasePointerCapture() {},
  }
  return element
}

const document = {
  nodeType: 9,
  readyState: 'complete',
  visibilityState: 'visible',
  hidden: false,
  title: 'dsh-aura selftest',
  createElement(tag) { return makeElement(tag) },
  createElementNS(_namespace, tag) { return makeElement(tag) },
  createTextNode(text) {
    const value = String(text)
    return {
      nodeType: 3,
      nodeValue: value,
      textContent: value,
      parentNode: null,
      parentElement: null,
      isConnected: false,
    }
  },
  createDocumentFragment() { return makeElement('#document-fragment') },
  querySelector() { return null },
  querySelectorAll() { return [] },
  getElementById() { return null },
  addEventListener(type) { documentListeners.add(String(type)) },
  removeEventListener(type) { documentListeners.delete(String(type)) },
  dispatchEvent() { return true },
}
document.documentElement = makeElement('html')
document.head = makeElement('head')
document.body = makeElement('body')
document.documentElement.appendChild(document.head)
document.documentElement.appendChild(document.body)
document.body.isConnected = true

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = String(type)
    this.detail = init.detail
    this.bubbles = Boolean(init.bubbles)
    this.cancelable = Boolean(init.cancelable)
    this.defaultPrevented = false
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() {}
}

class FakeAbortController {
  constructor() {
    this.signal = {
      aborted: false,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
      throwIfAborted() {
        if (this.aborted) throw new Error('aborted')
      },
    }
  }
  abort(reason) {
    this.signal.aborted = true
    this.signal.reason = reason
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    this.disconnected = false
    observers.push(this)
  }
  observe(target, options) { this.target = target; this.options = options }
  disconnect() { this.disconnected = true }
  takeRecords() { return [] }
}

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    observers.push(this)
  }
  observe(target) { this.target = target }
  unobserve() {}
  disconnect() {}
}

function getComputedStyle(element) {
  const style = (element && element.style) || {}
  return {
    ...style,
    getPropertyValue(name) { return style[name] ?? '' },
  }
}

/* ---------- 最小浏览器 / 网络 / 定时器 ---------- */

let timerSeq = 1
function fakeSetTimeout(callback, delay, ...args) {
  timers.push({ kind: 'timeout', delay, callback, args })
  return timerSeq++
}
function fakeSetInterval(callback, delay, ...args) {
  timers.push({ kind: 'interval', delay, callback, args })
  return timerSeq++
}
function fakeClearTimeout() {}
function fakeClearInterval() {}

function fakeFetch(url, options) {
  // 永不 settle：apply() 里的 primeAppearance / 表情索引加载不会继续跑，
  // 既不会联网，也不会产生需要清理的异步链。
  fetchCalls.push({ url: String(url), options })
  return new Promise(() => {})
}

const fakeConsole = {
  log() {},
  info() {},
  debug() {},
  trace() {},
  warn(...args) { warnings.push(args.map(String).join(' ')) },
  error(...args) { clientErrors.push(args.map(String).join(' ')) },
}

/* ---------- 最小 React ---------- */

const React = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  cloneElement(element, props, ...children) {
    return { ...element, props: { ...(element && element.props), ...(props || {}), children } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) { return factory() },
  useRef(value) { return { current: value } },
  useCallback(callback) { return callback },
  useContext() { return {} },
  useReducer(state) { return [state, () => {}] },
  memo(component) { return component },
  forwardRef(render) { return render },
  createContext(defaultValue) { return { Provider: 'Provider', Consumer: 'Consumer', defaultValue } },
}

const requireMap = new Map([['react', React]])
function fakeRequire(id) {
  if (requireMap.has(id)) return requireMap.get(id)
  throw new Error(`客户端加载自测未提供 require('${id}') 的替身`)
}

/* ---------- 装载 client.js ---------- */

let captured = null
const sandbox = {
  console: fakeConsole,
  document,
  navigator: {
    userAgent: 'dsh-aura-client-load-selftest',
    language: 'zh-CN',
    languages: ['zh-CN'],
  },
  location: {
    href: 'http://127.0.0.1/',
    origin: 'http://127.0.0.1',
    protocol: 'http:',
    host: '127.0.0.1',
    pathname: '/',
    search: '',
    hash: '',
  },
  fetch: fakeFetch,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  requestAnimationFrame(callback) { return fakeSetTimeout(callback, 16) },
  cancelAnimationFrame(id) { fakeClearTimeout(id) },
  AbortController: FakeAbortController,
  MutationObserver: FakeMutationObserver,
  ResizeObserver: FakeResizeObserver,
  CustomEvent: FakeCustomEvent,
  getComputedStyle,
  NodeFilter: { SHOW_TEXT: 4 },
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return true },
  __ModuleLoader__: {
    load(spec) { captured = spec },
  },
  __captured: null,
}

let source = ''
try {
  source = readFileSync(clientPath, 'utf8')
} catch (error) {
  fail(`读取 ${clientPath}`, error)
}

let context
try {
  context = vm.createContext(sandbox)
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context)
  const script = new vm.Script(source, { filename: clientPath })
  script.runInContext(context)
} catch (error) {
  fail('执行 client.js 顶层（ModuleLoader.load 之前）', error)
}

if (!captured) fail('window.__ModuleLoader__.load 没有被调用', new Error('未捕获到模块声明'))
check(captured.id === 'dsh-aura', `模块 id 应为 dsh-aura，实际是 ${String(captured.id)}`)
check(typeof captured.factory === 'function', 'load({ factory }) 缺少 factory 函数')

/* ---------- 真正执行 factory ---------- */

let plugin
try {
  plugin = captured.factory(fakeRequire)
} catch (error) {
  fail('factory(require) 顶层执行（ReferenceError 会在这里暴露）', error)
}

if (!plugin || typeof plugin !== 'object') fail('factory 没有返回模块对象', new Error(String(plugin)))
check(typeof plugin.apply === 'function', '模块对象缺少 apply(ctx)')
check(Array.isArray(plugin.inject), '模块 inject 应为数组')
check(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), `模块 inject 应包含 slots，实际是 ${JSON.stringify(plugin.inject)}`)

/* ---------- 执行 apply(fakeCtx) ---------- */

const records = {
  effects: [],
  injections: [],
  registrations: [],
  localeRegistrations: [],
  disposers: [],
}

const fakeLocale = {
  register(namespace, dictionaries) {
    records.localeRegistrations.push({ namespace, languages: Object.keys(dictionaries || {}) })
    return () => {}
  },
}

const slots = {
  inject(name, register) {
    records.injections.push(String(name))
    if (typeof register !== 'function') {
      throw new TypeError(`slots.inject(${String(name)}) 需要回调函数`)
    }
    const dispose = register()
    if (typeof dispose === 'function') records.disposers.push(dispose)
    return dispose
  },
  register(meta, component) {
    const name = meta && meta.name
    records.registrations.push({ name, id: meta && meta.id, key: meta && meta.key })
    if (typeof component !== 'function' && typeof component !== 'object') {
      throw new TypeError(`slots.register(${String(name)}) 缺少组件`)
    }
    return () => {}
  },
}

const ctx = {
  slots,
  effect(callback, label) {
    if (typeof callback !== 'function') throw new TypeError('ctx.effect 需要回调函数')
    records.effects.push(String(label || 'effect'))
    const dispose = callback()
    if (typeof dispose === 'function') records.disposers.push(dispose)
    return dispose
  },
  get(name) {
    if (name === 'locale') return fakeLocale
    return undefined
  },
  tools: {
    register() {},
  },
  systemPrompt: {
    register() { return () => {} },
  },
}

try {
  plugin.apply(ctx)
} catch (error) {
  fail('apply(fakeCtx) 同步执行（槽位注册 / effect 初始化）', error)
}

/* ---------- 行为断言 ---------- */

const requiredSlots = [
  'conversation.input.overlay',
  'conversation.input.left',
  'conversation.session.header.actions',
  'main',
  'sidebar.panellist',
]
for (const slot of requiredSlots) {
  check(records.injections.includes(slot), `apply 没有注册槽位 ${slot}`)
}
check(records.effects.length >= 2, `apply 应至少初始化 2 个 effect，实际 ${records.effects.length}`)
check(records.localeRegistrations.length === 1, `apply 应注册一次 locale，实际 ${records.localeRegistrations.length}`)
check(records.registrations.length >= requiredSlots.length, `apply 注册的槽位条目过少：${records.registrations.length}`)
check(records.registrations.some(row => row.name === 'main'), 'apply 没有注册 main 面板')
check(records.registrations.some(row => row.name === 'sidebar.panellist'), 'apply 没有注册侧栏入口')
check(observers.length >= 1, 'apply 没有启动 DOM observer')
check(document.head.children.filter(child => child.tagName === 'STYLE').length >= 2, 'apply 没有注入样式（表情内联 / 光轨）')
check(documentListeners.has('click') && documentListeners.has('keydown'), 'apply 没有挂聊天表情所需的文档监听')

if (clientErrors.length > 0) {
  failures.push(`客户端执行期间出现 console.error：\n${clientErrors.join('\n')}`)
}

/* ---------- 清理：模拟插件 dispose，确保卸载不抛错 ---------- */

for (const dispose of records.disposers.reverse()) {
  try {
    dispose()
  } catch (error) {
    failures.push(`dispose 阶段抛错：${error && error.stack ? error.stack : error}`)
  }
}

/* ---------- 结果 ---------- */

if (warnings.length > 0) {
  console.error('⚠️ 客户端执行期间出现警告：')
  for (const warning of warnings) console.error(`   ${warning}`)
}

if (failures.length > 0) {
  console.error(`❌ 客户端加载自测失败（${failures.length} 项）：`)
  for (const message of failures) console.error(`   - ${message}`)
  process.exit(1)
}

// 成功时只输出一行，便于 preflight 取最后一行。
console.log('客户端加载自测通过')
