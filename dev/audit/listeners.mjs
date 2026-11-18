/**
 * Measure the abort-listener behaviour of one prediction request.
 * Reading ask() suggested the abort listener is re-added for every chunk and only
 * removed when the signal fires; this probe counts the listeners on the signal the
 * route actually uses.
 */
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const host = await import(pathToFileURL('../../index.js').href)

const counts = new WeakMap()
const originalAdd = AbortSignal.prototype.addEventListener
const originalRemove = AbortSignal.prototype.removeEventListener
let peak = 0
AbortSignal.prototype.addEventListener = function add(type, fn, options) {
  if (type === 'abort') {
    const size = (counts.get(this) ?? 0) + 1
    counts.set(this, size)
    peak = Math.max(peak, size)
  }
  return originalAdd.call(this, type, fn, options)
}
AbortSignal.prototype.removeEventListener = function remove(type, fn, options) {
  if (type === 'abort') counts.set(this, Math.max(0, (counts.get(this) ?? 0) - 1))
  return originalRemove.call(this, type, fn, options)
}

const CHUNKS = 80
const session = {
  id: 'audit-session',
  snapshotEvents: () => ([
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我看下这个报错' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '先贴日志。' }] } } },
  ]),
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
}

let routes = {}
const ctx = {
  agents: { get: () => ({ session }) },
  llm: {
    async *stream() {
      for (let i = 0; i < CHUNKS; i += 1) yield { type: 'text-delta', text: '字' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  inject: (_deps, callback) => callback({
    effect: (fn) => { fn(); return () => {} },
    on: () => {},
    webServer: {
      register: (route) => { routes[route.path] = route; return () => {} },
    },
    clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
  }),
}

host.apply(ctx)

const route = routes['/composer-quill/predict']
const result = await new Promise((resolve) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
  const res = new EventEmitter()
  res.statusCode = 0
  res.writableEnded = false
  res.destroyed = false
  res.setHeader = () => {}
  res.end = (chunk) => resolve({ status: res.statusCode, body: String(chunk ?? '') })
  route.handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify({ sessionId: 'audit-session', mode: 'next', draft: '' })))
  req.emit('end')
})

console.log(`响应码 ${result.status}；模型分片 ${CHUNKS} 个`)
console.log(`单个 AbortSignal 上的 abort 监听器峰值：${peak}`)
const leaked = peak > 3
console.log(leaked ? 'FAIL 每个分片都会挂一个监听器（泄漏）' : 'PASS 监听器数量恒定')

AbortSignal.prototype.addEventListener = originalAdd
AbortSignal.prototype.removeEventListener = originalRemove
process.exit(leaked ? 1 : 0)
