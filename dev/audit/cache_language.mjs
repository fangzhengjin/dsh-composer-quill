/**
 * Does the suggestion cache ignore the language setting?
 * Two requests, same Session and draft, different `language` values: the second
 * must not be served from the cache built by the first.
 */
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

const host = await import(pathToFileURL('../../index.js').href)

let modelCalls = 0
const session = {
  id: 'audit-cache',
  snapshotEvents: () => ([
    { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我把日志整理一下' }] } },
    { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '先贴日志。' }] } } },
  ]),
  requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
}

const routes = {}
const ctx = {
  agents: { get: () => ({ session }) },
  llm: {
    async *stream() {
      modelCalls += 1
      yield { type: 'text-delta', text: '，把日志贴上来。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  inject: (_deps, callback) => callback({
    effect: (fn) => { fn(); return () => {} },
    on: () => {},
    webServer: { register: (route) => { routes[route.path] = route; return () => {} } },
    clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
  }),
}

// Keep the suggestion cache out of the real profile directory.
process.env.DSH_COMPOSER_QUILL_NO_CACHE = '1'
host.apply(ctx)

const call = (payload) => new Promise((resolve) => {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
  const res = new EventEmitter()
  res.statusCode = 0
  res.writableEnded = false
  res.destroyed = false
  res.setHeader = () => {}
  res.end = (chunk) => resolve(chunk === undefined ? null : JSON.parse(String(chunk)))
  routes['/composer-quill/predict'].handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(payload)))
  req.emit('end')
})

const base = { sessionId: 'audit-cache', mode: 'compose', draft: '帮我把日志' }
const first = await call({ ...base, language: 'auto' })
const afterFirst = modelCalls
const second = await call({ ...base, language: 'en' })
const afterSecond = modelCalls

console.log('第一次（auto）：', JSON.stringify(first).slice(0, 90), `模型调用=${afterFirst}`)
console.log('第二次（en）  ：', JSON.stringify(second).slice(0, 90), `模型调用=${afterSecond}`)
const reused = afterSecond === afterFirst
console.log(reused
  ? 'FAIL 切换语言设置后仍复用了旧语言的缓存结果'
  : 'PASS 语言设置变化会重新请求')
process.exit(reused ? 1 : 0)
