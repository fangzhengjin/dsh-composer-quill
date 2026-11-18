/**
 * Offline smoke test for dsh-composer-quill.
 *
 * Runs without DSH and without a browser: Host pure helpers, the browser module
 * factory, both slot registrations, the beacon, and the two request triggers
 * (next message, compose) against stub props and a stub fetch.
 *
 * Usage: node smoke-test.mjs
 */
process.env.DSH_COMPOSER_QUILL_NO_CACHE = '1'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) } catch (error) { failures += 1; console.log(`  FAIL ${name}: ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`) } catch (error) { failures += 1; console.log(`  FAIL ${name}: ${error.message}`) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- Host half
const host = await import(pathToFileURL('./index.js').href)

check('host exports name/inject/apply', () => {
  assert.equal(host.name, 'composerQuill')
  assert.deepEqual(host.inject, ['llm', 'agents'])
  assert.equal(typeof host.apply, 'function')
})

check('parseCandidates reads a JSON object', () => {
  assert.deepEqual(host.__test.parseCandidates('{"candidates":["继续","换个思路"]}'), ['继续', '换个思路'])
})

check('parseCandidates survives code fences and chatter', () => {
  const list = host.__test.parseCandidates('```json\n{"candidates":["  1. 接着写  ", "- 看下日志"]}\n```')
  assert.deepEqual(list, ['接着写', '看下日志'])
})

check('parseCandidates falls back to lines and drops SKIP/dupes', () => {
  assert.deepEqual(host.__test.parseCandidates('* 第一条\n2) 第二条\nSKIP\n第一条'), ['第一条', '第二条'])
})

check('parseCandidates caps at three and rejects oversize', () => {
  const list = host.__test.parseCandidates(JSON.stringify({ candidates: ['a', 'b', 'c', 'd', 'x'.repeat(200)] }))
  assert.deepEqual(list, ['a', 'b', 'c'])
})

check('parseComposed returns the finished-and-tidied message', () => {
  const draft = '帮我把这段日'
  assert.equal(
    host.__test.parseComposed('```json\n{"text":"帮我把这段日志整理一下，找出报错的那几行。"}\n```', draft),
    '帮我把这段日志整理一下，找出报错的那几行。',
  )
})

check('parseComposed ignores a reply that only restates the draft', () => {
  assert.equal(host.__test.parseComposed('{"text":"帮我把这段日"}', '帮我把这段日'), null)
})

check('parseComposed rejects truncation and runaway rewrites', () => {
  const draft = '帮我把这段日志完整地整理一下，并把报错的行标出来，然后给出下一步建议。'
  assert.equal(host.__test.parseComposed('{"text":"帮我把"}', draft), null, 'truncated rewrite slipped through')
  assert.equal(host.__test.parseComposed(JSON.stringify({ text: 'x'.repeat(1200) }), draft), null, 'runaway rewrite slipped through')
})

check('parseSentence reads a fallback sentence', () => {
  assert.equal(host.__test.parseSentence('{"sentence":"请把报错行号贴上。"}'), '请把报错行号贴上。')
  assert.equal(host.__test.parseSentence('{"sentence":""}'), null)
  assert.equal(host.__test.parseSentence('```json\n{"sentence":"顺便给出复现步骤"}\n```'), '顺便给出复现步骤')
})

check('joinSentence glues a sentence the way a person would', () => {
  const { joinSentence } = host.__test
  assert.equal(joinSentence('帮我看下这个报错。', '请把行号贴上。'), '帮我看下这个报错。请把行号贴上。')
  assert.equal(joinSentence('帮我看下这个报错', '请把行号贴上'), '帮我看下这个报错请把行号贴上。')
  assert.equal(joinSentence('Explain the trace', 'and cite the lines'), 'Explain the trace and cite the lines.')
})

check('parseComposeReply splits Case A tails from Case B rewrites', () => {
  const { parseComposeReply } = host.__test
  const tail = parseComposeReply('，请把行号贴上。', '帮我看下这个报错')
  assert.equal(tail.mode, 'append')
  assert.equal(tail.text, '帮我看下这个报错，请把行号贴上。')
  const rewrite = parseComposeReply('REWRITE:\n帮我看下这个报错，并把行号贴上。', '帮我看下这个报错')
  assert.equal(rewrite.mode, 'full')
  assert.equal(rewrite.text, '帮我看下这个报错，并把行号贴上。')
  assert.equal(parseComposeReply('帮我看下这个报错', '帮我看下这个报错'), null, 'echo must not become a tail')
  assert.equal(parseComposeReply('', '帮我看下这个报错'), null)
})

// ------------------------------------------------- Host route, fake model
{
  const draft = '帮我看看这个报错是怎么回事。'
  let call = 0
  const session = {
    id: 's-fake',
    snapshotEvents: () => [],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        call += 1
        const text = call === 1
          ? ''                                       // compose: nothing to add
          : '请把报错行号贴上。'                       // fallback sentence (plain text)
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    inject: (_deps, callback) => callback({
      effect: (fn) => { fn(); return () => {} },
      on: () => {},
      webServer: {
        register: (route) => {
          if (route.path === '/composer-quill/predict') globalThis.__predictRoute = route
          return () => {}
        },
      },
      clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [{ id: 'dsh-composer-quill' }] }) },
    }),
  }
  host.apply(ctx)
  const route = globalThis.__predictRoute

  const request = (body) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.headers = {}
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = (name, value) => { res.headers[name] = value }
    res.end = (payload) => { res.writableEnded = true; resolve({ status: res.statusCode, body: payload }) }
    route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })

  await checkAsync('compose falls back to an appended sentence when the model says unchanged', async () => {
    call = 0
    const { status, body } = await request({ sessionId: 's-fake', mode: 'compose', draft })
    const parsed = JSON.parse(body)
    assert.equal(status, 200)
    assert.equal(parsed.fallback, 'sentence', `body=${body}`)
    assert.ok(typeof parsed.text === 'string' && parsed.text.length > 0, `body=${body}`)
  })
}

check('maskSecrets hides the credential shapes we may see in a transcript', () => {
  const { maskSecrets } = host.__test
  const cases = [
    ['AWS AKIAABCDEFGHIJKLMNOP here', 'AKIAABCDEFGHIJKLMNOP'],
    ['key sk-proj-abcdefghijklmnopqrstuvwx', 'sk-proj-abcdefghijklmnopqrstuvwx'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['pat github_pat_11ABCDEFG0abcdefghijklmnop', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['slack xoxb-1234567890-abcdefghijkl', 'xoxb-1234567890-abcdefghijkl'],
    ['stripe sk_live_abcdefghijklmnop', 'sk_live_abcdefghijklmnop'],
    ['jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM'],
    ['auth Bearer abcdefghijklmnopqrstuvwx', 'Bearer abcdefghijklmnopqrstuvwx'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ]
  for (const [input, secret] of cases) {
    const masked = maskSecrets(input)
    assert.ok(!masked.includes(secret), `leaked: ${masked}`)
    assert.ok(masked.includes('redacted'), `no marker: ${masked}`)
  }
  // Ordinary text survives untouched.
  assert.equal(maskSecrets('帮我把这段日志整理一下'), '帮我把这段日志整理一下')
})

check('transcriptOf masks secrets on the way out', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'key=sk-proj-abcdefghijklmnopqrstuvwx' }] } },
  ]
  const rows = JSON.parse(host.__test.transcriptOf(events))
  assert.ok(!rows[0].text.includes('sk-proj-'), rows[0].text)
  assert.ok(rows[0].text.includes('redacted'), rows[0].text)
})
check('a huge emoji message neither hangs nor explodes the transcript', () => {
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: '😀'.repeat(1500) }] } }]
  const started = Date.now()
  const out = host.__test.transcriptOf(events)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `took ${elapsed}ms`)
  assert.ok(out.length < 12000, `output ${out.length} chars`)
  assert.ok(out.includes('user'), 'the newest user turn must survive')
})

check('shorten never grows the text', () => {
  const { shorten } = host.__test
  const emoji = '😀'.repeat(200)
  for (const limit of [10, 100, 400]) {
    const out = shorten(emoji, limit)
    assert.ok(Array.from(out).length <= Math.max(limit, 40) + 40, `limit ${limit}: ${Array.from(out).length}`)
  }
})

check('historyOf keeps the user turns, newest last, without duplicates', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看这个报错' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '把日志按时间排一下' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看这个报错' }] } },
  ]
  const items = host.__test.historyOf(events)
  assert.deepEqual(items.map((item) => item.text), ['把日志按时间排一下', '帮我看看这个报错'])
})

check('a two-character draft never gets a fragment tail', () => {
  const { parseComposeReply } = host.__test
  // Tails are refused when the draft is too short to continue...
  assert.equal(parseComposeReply('，把日志贴上来', '帮', { allowTail: false }), null)
  // ...but the same reply is fine once the draft carries enough context.
  const kept = parseComposeReply('，把日志贴上来', '帮我看看这个报错', { allowTail: true })
  assert.equal(kept?.mode, 'append')
  // A rewrite is always acceptable.
  const rewrite = parseComposeReply('REWRITE: 帮我看看这段代码有什么问题', '帮', { allowTail: false })
  assert.equal(rewrite?.mode, 'full')
})

check('a next-message with no link to the conversation is dropped', () => {
  const { groundedness, MIN_GROUNDEDNESS } = host.__test
  const context = JSON.stringify([
    { role: 'user', text: '帮我把 dsh-composer-quill 插件的语言设置拆开' },
    { role: 'assistant', text: '语言设置只影响空输入时的下一句建议，补写跟随已有文本。' },
  ])
  // On-topic: shares wording with the transcript.
  assert.ok(groundedness('补写要跟随前面的文本，不要被设置影响', context) >= MIN_GROUNDEDNESS)
  assert.ok(groundedness('语言设置那部分改完了吗', context) >= MIN_GROUNDEDNESS)
  // Off-topic: nothing in common.
  assert.ok(groundedness('明天上海天气怎么样，要不要带伞', context) < MIN_GROUNDEDNESS)
})

check('the language setting overrides every heuristic', () => {
  const { resolveLanguage, rankCandidates, wrongLanguage } = host.__test

  // A chosen language beats the profile, the locale and the draft.
  assert.equal(resolveLanguage({ profile: { language: 'en' }, locale: 'en-US', forced: 'zh' }), 'zh')
  assert.equal(resolveLanguage({ profile: { language: 'zh' }, locale: 'zh-CN', forced: 'en' }), 'en')
  // 'auto' falls back to the old chain.
  assert.equal(resolveLanguage({ profile: { language: 'zh' }, locale: 'en-US', forced: '' }), 'zh')

  // Forced: an English answer is dropped and the list stays empty (the user asked
  // for that language, so silence is honest).
  const forcedZh = rankCandidates(
    ['Skip the rest and paste the trace.', 'Let me rerun the suite first.'],
    { profile: { count: 0 }, locale: 'zh-CN', forced: 'zh' },
  )
  assert.deepEqual(forcedZh, [])

  // Inferred: the same list still shows something.
  const autoZh = rankCandidates(
    ['Skip the rest and paste the trace.', 'Let me rerun the suite first.'],
    { profile: { count: 0 }, locale: 'zh-CN', forced: '' },
  )
  assert.ok(autoZh.length > 0)

  // A Chinese draft with an English tail is refused when Chinese is forced.
  assert.equal(wrongLanguage(' and make it deterministic.', 'zh'), true)
})

check('the language gate holds even without a transcript', () => {
  const { resolveLanguage, wrongLanguage, rankCandidates, parseComposeReply } = host.__test

  // No style profile at all (Host holds no transcript): the browser locale decides.
  assert.equal(resolveLanguage({ profile: { count: 0 }, locale: 'zh-CN' }), 'zh')
  assert.equal(resolveLanguage({ profile: { count: 0 }, locale: 'en-US' }), 'en')
  assert.equal(resolveLanguage({ profile: { count: 0 }, locale: '', draft: '帮我看看' }), 'zh')

  // Mostly-Latin text counts as English even when it carries a few Chinese words.
  assert.equal(wrongLanguage('Skip all three for now（先跳过）', 'zh'), true)
  assert.equal(wrongLanguage('把日志贴上来，我看一下', 'zh'), false)
  assert.equal(wrongLanguage('OK', 'zh'), false, 'very short replies are tolerated')

  // The wrong-language candidates lose to the right-language one...
  const ranked = rankCandidates(
    ['Skip the rest and paste the trace.', '把剩下的日志贴上来我看一下'],
    { profile: { count: 0 }, locale: 'zh-CN' },
  )
  assert.equal(ranked[0], '把剩下的日志贴上来我看一下', JSON.stringify(ranked))
  // ...but an all-English answer is still shown: a heuristic must never leave
  // the user with silence (that outage is exactly what happened in 0.17.1).
  const onlyEnglish = rankCandidates(
    ['Skip the rest and paste the trace.', 'Let me rerun the suite first.'],
    { profile: { count: 0 }, locale: 'zh-CN' },
  )
  assert.ok(onlyEnglish.length > 0, 'silence is worse than the wrong language')

  // A Chinese draft cannot be finished in English, locale or not.
  assert.equal(parseComposeReply(' and make it deterministic.', '帮我修一下这个测试'), null)
  assert.equal(parseComposeReply('，把复现步骤贴一下。', '帮我修一下这个测试')?.mode, 'append')
})

check('a suggestion never switches language on the user', () => {
  const { scriptOf, rankCandidates, parseComposeReply } = host.__test
  assert.equal(scriptOf('帮我把日志整理一下'), 'zh')
  assert.equal(scriptOf('fix the flaky test'), 'en')
  assert.equal(scriptOf('OK'), 'en')
  assert.equal(scriptOf('帮我看下 fix'), 'mixed')

  const profile = { count: 9, avgChars: 20, language: 'zh', usesGreeting: false }
  const ranked = rankCandidates(
    ['Skip all three for now. The two remaining issues are the leading comma and the csv case.', '先把这三条都跳过，然后把剩下两个问题说完。'],
    { profile, lastAssistant: 'The draft is fine.', lastUser: '继续' },
  )
  assert.deepEqual(ranked, ['先把这三条都跳过，然后把剩下两个问题说完。'], JSON.stringify(ranked))

  // A Chinese draft must not be finished in English.
  assert.equal(parseComposeReply(' and make it deterministic.', '帮我修一下这个不稳定的测试'), null)
  // ...but an English draft with an English tail is fine.
  const kept = parseComposeReply(' and make it deterministic.', 'fix the flaky test')
  assert.equal(kept?.text, 'fix the flaky test and make it deterministic.')
})

check('model commentary is never offered as a completion', () => {
  const { looksLikeMeta, parseComposeReply } = host.__test
  const leaks = [
    'The draft is already complete and sound, so no addition is warranted.',
    'No further additions are needed.',
    'Nothing to add here.',
    '无需补充内容。',
    '草稿已经完整。',
  ]
  for (const text of leaks) {
    assert.equal(looksLikeMeta(text), true, text)
    assert.equal(parseComposeReply(text, '帮我看看这个报错'), null, `tail leaked: ${text}`)
    assert.equal(parseComposeReply(`REWRITE: ${text}`, '帮我看看这个报错'), null, `rewrite leaked: ${text}`)
  }
  // A real completion survives.
  assert.equal(looksLikeMeta('，把报错行和时间一起贴上来。'), false)
})

check('styleProfile describes how this user writes', () => {
  const { styleProfile } = host.__test
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: '帮我把日志整理一下' }] } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '再看下报错在哪里' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '把结论写成三条' }] } },
  ]
  const profile = styleProfile(events)
  assert.equal(profile.count, 3)
  assert.ok(profile.avgChars > 5 && profile.avgChars < 20, JSON.stringify(profile))
  assert.equal(profile.language, 'zh')
  assert.equal(profile.usesGreeting, false)
})

check('candidates are ranked by fit, not by model order', () => {
  const { rankCandidates } = host.__test
  const profile = { count: 5, avgChars: 12, language: 'zh', usesGreeting: false }
  const lastAssistant = '报错指向第 42 行的空指针，需要贴出那附近十行日志。'
  const ranked = rankCandidates(
    ['好的，我来看看这个问题的具体情况吧。', '我把第 42 行附近的日志贴出来。', '还有别的吗'],
    { profile, lastAssistant, lastUser: '帮我看下报错' },
  )
  assert.ok(ranked.length >= 1, JSON.stringify(ranked))
  // The greeting opener is pushed to the back.
  assert.notEqual(ranked[0], '好的，我来看看这个问题的具体情况吧。', JSON.stringify(ranked))
})

check('a long session keeps the topic the draft is about', () => {
  const { transcriptOf, sessionDigest } = host.__test
  const events = []
  for (let turn = 1; turn <= 20; turn += 1) {
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${turn}轮：请帮我看一下 CSV 导出脚本的时区问题，编号 ${turn}` }] } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${turn}轮回答：时区问题通常是 UTC 与本地时间混用导致的。` }] } } })
  }
  for (let turn = 21; turn <= 30; turn += 1) {
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${turn}轮：帮我看看这个前端报错怎么修，编号 ${turn}` }] } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${turn}轮回答：前端问题通常和依赖版本有关。` }] } } })
  }
  const draft = '再帮我看下 CSV 导出的时区'
  const plain = transcriptOf(events, { rows: 10, chars: 3200 })
  const focused = transcriptOf(events, { rows: 10, chars: 3200, focus: draft })
  assert.equal((plain.match(/CSV/g) ?? []).length, 0, 'without focus the topic is out of the window')
  assert.ok((focused.match(/CSV/g) ?? []).length >= 1, 'focus must pull the topic back in')
  assert.ok(focused.length <= 3400, `window grew too much: ${focused.length}`)

  const digest = sessionDigest(events)
  assert.ok(digest.thesis.includes('CSV'), JSON.stringify(digest))
  assert.equal(digest.recentUserMessages.length, 3)
})

check('the diagnostic log rotates once it grows', () => {
  const { rotateLog, LOG_MAX_BYTES } = host.__test
  const file = `${tmpdir()}/ghost-log-test-${process.pid}.log`
  writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES + 10))
  rotateLog(file)
  assert.equal(existsSync(file), false, 'the oversized log should be renamed away')
  assert.equal(existsSync(`${file}.1`), true, 'a rotated copy should exist')
  rmSync(`${file}.1`, { force: true })
})

check('transcriptOf keeps the latest user turn', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'first ask' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a reply' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'latest ask' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'second reply' }] } } },
  ]
  const rows = JSON.parse(host.__test.transcriptOf(events))
  assert.equal(rows.at(-1).text, 'second reply')
  assert.ok(rows.some((row) => row.text === 'latest ask'))
})

check('authorized accepts the token or a browser that sent the preflight header', () => {
  const { authorized } = host.__test
  const token = 'abc'
  const client = { 'x-composer-quill-client': '1', 'content-type': 'application/json' }
  assert.equal(authorized({ headers: { 'x-composer-quill-token': token, 'content-type': 'application/json' } }, token), true)
  assert.equal(authorized({ headers: { 'x-composer-quill-token': 'other', 'content-type': 'application/json' } }, token), false)
  // Without the custom header there is no preflight barrier: reject.
  assert.equal(authorized({ headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' } }, token), false)
  assert.equal(authorized({ headers: { ...client, 'sec-fetch-site': 'same-origin' } }, token), true)
  assert.equal(authorized({ headers: { ...client, 'sec-fetch-site': 'cross-site' } }, token), false)
  // A local process can type any header: without the browser's own signal it is
  // not treated as same-origin.
  assert.equal(authorized({ headers: { ...client } }, token), false)
  assert.equal(authorized({ headers: { 'content-type': 'application/json' } }, token), false)
  assert.equal(authorized({ headers: { ...client, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' } }, token), false)
})

// -------------------------------------------------------------- Client half
const registered = []
const disposers = []
let effectQueue = []

const fakeReact = {
  Fragment: Symbol('Fragment'),
  Component: class { constructor(props) { this.props = props; this.state = {} } },
  createElement: (...args) => ({ $$el: args }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [initial, () => {}],
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useEffect: (fn) => { effectQueue.push(fn) },
}

const calls = []
const reply = (url, body) => {
  if (url.includes('/beacon')) return { ok: true }
  if (body.mode === 'compose') return { kind: 'compose', text: `${body.draft}，找出报错的那几行。` }
  return { kind: 'next', candidates: ['候选甲'] }
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push({ url, mode: body.mode ?? 'beacon', draft: body.draft ?? '', sessionId: body.sessionId ?? null })
  return { ok: true, status: 200, json: async () => reply(url, body) }
}

globalThis.window = {
  __ModuleLoader__: { load({ id, factory }) { globalThis.__ghostFactory = { id, factory } } },
  __DSH_COMPOSER_QUILL_TOKEN__: 'test-token',
  localStorage: (() => {
    const store = new Map()
    return {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
      clear: () => store.clear(),
    }
  })(),
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: () => {},
}

globalThis.document = {
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: { appendChild: () => {} },
  createElement: () => ({ style: { cssText: '' }, setAttribute: () => {}, appendChild: () => {}, remove: () => {}, querySelector: () => null }),
  getElementById: () => null,
}

await import(pathToFileURL('./client.js').href)
check('client registers a module factory', () => {
  assert.equal(globalThis.__ghostFactory.id, 'dsh-composer-quill')
})

const moduleExports = globalThis.__ghostFactory.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require(${name})`)
})

check('client exports slots + locale inject', () => {
  assert.deepEqual(moduleExports.inject, ['slots', 'locale'])
  assert.equal(typeof moduleExports.apply, 'function')
})

check('followRemainder shrinks the tail while the user types into it', () => {
  const { followRemainder } = moduleExports.__test
  const full = '帮我把这段日志，找出报错的那几行'
  assert.equal(followRemainder(full, '帮我把这段日'), '志，找出报错的那几行')
  assert.equal(followRemainder(full, '帮我把这段日志，找出报错'), '的那几行')
  assert.equal(followRemainder(full, '帮我把这段日志，找出报错的那几行'), '')
  assert.equal(followRemainder(full, '完全不同的输入'), '')
  assert.equal(followRemainder('', '草稿'), '')
})


check('bestHistoryMatch prefers the newest prefix match', () => {  const { bestHistoryMatch } = moduleExports.__test
  const items = [
    { text: '帮我看看这个报错的堆栈' },
    { text: '帮我看看这个报错的原因' },
    { text: '完全无关的一句话' },
  ]
  const match = bestHistoryMatch(items, '帮我看看这个报错')
  assert.ok(match, 'no match')
  assert.equal(match.text, '帮我看看这个报错的原因', 'newest match should win')
  assert.equal(match.tail, '的原因')
  assert.equal(bestHistoryMatch(items, '帮我看看这个报错的原因'), null, 'a completed message must not match itself')
  const short = bestHistoryMatch(items, '帮')
  assert.ok(short, 'a single character must be enough')
  assert.equal(bestHistoryMatch(items, ''), null, 'an empty draft has nothing to match')
})

const ctx = {
  effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
  locale: {
    register: (ns, dictionaries) => {
      assert.equal(ns, 'composer-quill')
      assert.ok(dictionaries.zh['settings.title'])
      assert.ok(dictionaries.en['hint.replace'])
      return () => {}
    },
  },
  slots: {
    inject: (name, factory) => { factory(); return () => {} },
    register: (options, component) => {
      registered.push({ name: options.name, id: options.id, order: options.order, locale: options.locale, component, inject: options.inject })
      return () => {}
    },
  },
}

await moduleExports.apply(ctx)

check('registers the composer dock and the settings row', () => {
  const names = registered.map((entry) => entry.name)
  assert.ok(names.includes('conversation.input.dock'), 'missing conversation.input.dock')
  assert.ok(names.includes('settings.general.item'), 'missing settings.general.item')
})

check('every registration carries id, order and locale', () => {
  for (const entry of registered) {
    assert.equal(typeof entry.id, 'string')
    assert.equal(typeof entry.order, 'number')
    assert.equal(entry.locale, 'composer-quill')
    assert.equal(typeof entry.component, 'function')
  }
})

const preferences = { subscribe: () => () => {}, getSnapshot: () => true, set: () => {} }
const entryOf = (name) => registered.find((entry) => entry.name === name)

/** Registrations are wrapped in the error boundary; render the inner entry. */
const unwrap = (element) => {
  if (element && element.$$el && typeof element.$$el[0] !== 'string') {
    const child = element.$$el[2]
    if (child && child.$$el) {
      const [Inner, innerProps] = child.$$el
      return Inner(innerProps)
    }
    return null
  }
  return element
}
const renderDock = (props) => unwrap(entryOf('conversation.input.dock').component(props))

const props = (overrides = {}) => {
  const face = entryOf('conversation.input.dock').inject()
  return {
    session: { sessionId: 's-ident', running: false },
    input: { draft: '' },
    inputActions: { insertText: () => true, setDraft: () => true, captureInsertion: () => ({ draftRev: 0 }) },
    t: (key) => key,
    ...face,
    ...overrides,
  }
}

await checkAsync('mount posts the diagnostic beacon first', async () => {
  calls.length = 0
  effectQueue = []
  renderDock(props({ session: { sessionId: 's-beacon', running: false } }))
  for (const run of effectQueue) run()
  await wait(120)
  const beacon = calls.find((call) => call.mode === 'beacon' && call.sessionId === 's-beacon')
  assert.ok(beacon, `no beacon: ${JSON.stringify(calls)}`)
  await wait(400)
})

await checkAsync('an idle Session requests exactly one next-message prediction', async () => {
  calls.length = 0
  effectQueue = []
  renderDock(props({ session: { sessionId: 's-next', running: false } }))
  for (const run of effectQueue) run()
  await wait(500)
  const prediction = calls.filter((call) => call.mode === 'next' && call.sessionId === 's-next')
  assert.equal(prediction.length, 1, `next calls: ${JSON.stringify(calls)}`)
})

await checkAsync('typing requests one compose call carrying the draft', async () => {
  calls.length = 0
  effectQueue = []
  renderDock(props({ session: { sessionId: 's-type', running: false }, input: { draft: '帮我把这段日志' } }))
  for (const run of effectQueue) run()
  await wait(900)
  const compose = calls.filter((call) => call.mode === 'compose' && call.sessionId === 's-type')
  assert.equal(compose.length, 1, `calls: ${JSON.stringify(calls)}`)
  assert.equal(compose[0].draft, '帮我把这段日志')
})

await checkAsync('the dock renders one chip for the compose proposal', async () => {
  calls.length = 0
  effectQueue = []
  const tree = renderDock(props({ session: { sessionId: 's-chip', running: false }, input: { draft: '帮我把这段日志' } }))
  for (const run of effectQueue) run()
  await wait(900)
  // Re-render with the settled store so the chip has something to show.
  effectQueue = []
  const settled = renderDock(props({ session: { sessionId: 's-chip', running: false }, input: { draft: '帮我把这段日志' } }))
  for (const run of effectQueue) run()
  const node = settled ?? tree
  assert.ok(node && node.$$el, 'no chip rendered after a proposal')
  const row = node.$$el.slice(2).find((child) => child && child.$$el && child.$$el[0] === 'div')
  assert.ok(row, 'dock row missing')
  const button = row.$$el.slice(2).find((child) => child && child.$$el && child.$$el[0] === 'button')
  assert.ok(button, 'proposal chip missing')
  assert.ok(String(button.$$el[2]).includes('hint.'), 'chip should name its hint key')
})


check('stored suggestions are reused, expire and clear per session', () => {
  const { saveSuggestion, loadSuggestion, clearSessionSuggestions } = moduleExports.__test
  window.localStorage.clear()
  saveSuggestion('s-a', 'next', '', ['继续看下去', '换个思路'])
  saveSuggestion('s-b', 'compose', '帮我把这段日志', ['帮我把这段日志整理一下'])
  assert.deepEqual(loadSuggestion('s-a', 'next', ''), ['继续看下去', '换个思路'])
  assert.deepEqual(loadSuggestion('s-b', 'compose', '帮我把这段日志'), ['帮我把这段日志整理一下'])
  assert.equal(loadSuggestion('s-missing', 'next', ''), null)

  // Expiry: rewrite the entry with an old timestamp.
  const map = JSON.parse(window.localStorage.getItem('dsh.composer-quill.suggestions'))
  for (const key of Object.keys(map)) map[key].at = Date.now() - 11 * 60_000
  window.localStorage.setItem('dsh.composer-quill.suggestions', JSON.stringify(map))
  assert.equal(loadSuggestion('s-a', 'next', ''), null, 'an 11-minute-old suggestion must expire')

  // Clearing one session leaves the others alone.
  saveSuggestion('s-a', 'next', '', ['x'])
  saveSuggestion('s-b', 'next', '', ['y'])
  clearSessionSuggestions('s-a')
  assert.equal(loadSuggestion('s-a', 'next', ''), null)
  assert.deepEqual(loadSuggestion('s-b', 'next', ''), ['y'])
})

check('hydrate shows a stored suggestion without a request', () => {
  const face = entryOf('conversation.input.dock').inject()
  const ghost = face.ghost
  ghost.clear()
  const shown = ghost.hydrate('s-h', 'next', '', ['继续之前的话题'])
  assert.equal(shown, true)
  assert.deepEqual(ghost.getSnapshot().items, ['继续之前的话题'])
  assert.equal(ghost.getSnapshot().phase, 'ready')
  // A live result wins: hydrate must not overwrite one.
  ghost.streamStart('s-h', 'next', '')
  const second = ghost.hydrate('s-h', 'next', '', ['别的'])
  assert.equal(second, false)
})

check('normalizeConfig clamps and defaults every field', () => {
  const { normalizeConfig } = moduleExports.__test
  assert.deepEqual(normalizeConfig(null), { enabled: true, mode: 'auto', language: 'auto', debounceMs: 250, timeoutMs: 20000 })
  assert.equal(normalizeConfig({ language: 'zh' }).language, 'zh')
  assert.equal(normalizeConfig({ language: 'klingon' }).language, 'auto')
  assert.deepEqual(normalizeConfig({ enabled: false, mode: 'manual', debounceMs: 9999, timeoutMs: 10 }),
    { enabled: false, mode: 'manual', language: 'auto', debounceMs: 2000, timeoutMs: 3000 })
  assert.deepEqual(normalizeConfig({ mode: 'nonsense', debounceMs: 'abc' }).mode, 'auto')
  assert.equal(normalizeConfig({ debounceMs: '150' }).debounceMs, 150)
})

check('settings row renders the mode, pause and timeout controls', () => {
  const tree = unwrap(entryOf('settings.general.item').component({
    t: (key) => key,
    config: { subscribe: () => () => {}, getSnapshot: () => ({ enabled: true, mode: 'auto', debounceMs: 250, timeoutMs: 20000 }), set: () => {} },
  }))
  const flat = JSON.stringify(tree)
  for (const marker of ['settings-mode', 'settings-debounce', 'settings-timeout', 'settings.manualHint']) {
    assert.ok(flat.includes(marker), `missing ${marker}`)
  }
})

/** The prompt that reaches the model must not carry a raw credential. */
{
  const prompts = []
  const session = {
    id: 's-secret',
    snapshotEvents: () => ([
      { type: 'user/message', data: { content: [{ type: 'text', text: '我的 key 是 sk-proj-abcdefghijklmnopqrstuvwx 能用吗' }] } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => ({ session }) },
    llm: {
      async *stream(options) {
        prompts.push(options.messages[0].content[0].text)
        yield { type: 'text-delta', text: '，请把 key 换成环境变量。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    inject: (_deps, callback) => callback({
      effect: (fn) => { fn(); return () => {} },
      on: () => {},
      webServer: { register: (route) => { if (route.path === '/composer-quill/predict') globalThis.__secretRoute = route; return () => {} } },
      clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
    }),
  }
  host.apply(ctx)
  const route = globalThis.__secretRoute

  await checkAsync('the model prompt is masked before it leaves the host', async () => {
    const body = { sessionId: 's-secret', mode: 'compose', draft: '帮我看看这个报错' }
    await new Promise((resolve) => {
      const req = new EventEmitter()
      req.method = 'POST'
      req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
      const res = new EventEmitter()
      res.statusCode = 0
      res.writableEnded = false
      res.destroyed = false
      res.setHeader = () => {}
      res.end = () => resolve()
      route.handler(req, res)
      req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    assert.ok(prompts.length > 0, 'no model call captured')
    const prompt = prompts.join('\n')
    assert.ok(!prompt.includes('sk-proj-abcdefghijklmnopqrstuvwx'), 'raw key reached the model prompt')
    assert.ok(prompt.includes('redacted'), prompt.slice(0, 200))
  })
}

/** A draft ending with a newline must still get an inline tail, not a rewrite. */
await checkAsync('trailing newline still yields a tail proposal', async () => {
  const frames = [
    'event: start\ndata: {"mode":"append"}\n\n',
    'event: delta\ndata: {"text":"，请附上完整日志。"}\n\n',
    'event: final\ndata: {"text":"，请附上完整日志。"}\n\n',
    'event: done\ndata: {}\n\n',
  ].map((frame) => new TextEncoder().encode(frame))

  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined }
            const value = frames[index]
            index += 1
            return { done: false, value }
          },
          async cancel() {},
        }
      },
    },
    async json() { throw new Error('stream should not be read as JSON') },
  })

  try {
    const face = entryOf('conversation.input.dock').inject()
    face.ghost.clear()
    effectQueue = []
    const draft = '帮我看下这个报错\n'
    renderDock(props({ session: { sessionId: 's-nl', running: false }, input: { draft } }))
    for (const run of effectQueue) run()
    for (let i = 0; i < 40; i += 1) {
      await wait(50)
      if (face.ghost.getSnapshot().phase === 'ready') break
    }
    const snapshot = face.ghost.getSnapshot()
    assert.equal(snapshot.items[0], '帮我看下这个报错，请附上完整日志。', `items=${JSON.stringify(snapshot.items)}`)

    effectQueue = []
    const tree = renderDock(props({ session: { sessionId: 's-nl', running: false }, input: { draft } }))
    for (const run of effectQueue) run()
    const row = tree && tree.$$el.slice(2).find((child) => child && child.$$el && child.$$el[0] === 'div')
    const chip = row && row.$$el.slice(2).find((child) => child && child.$$el && child.$$el[0] === 'button')
    assert.ok(chip, 'no chip for the trailing-newline draft')
    assert.ok(String(chip.$$el[2]).startsWith('hint.complete'), `expected a tail hint, got ${String(chip.$$el[2]).slice(0, 20)}`)
  } finally {
    globalThis.fetch = previousFetch
  }
})
/** A thin answer (one candidate) is topped up by asking once more. */
{
  let calls = 0
  const session = {
    id: 's-topup',
    snapshotEvents: () => ([
      { type: 'user/message', data: { content: [{ type: 'text', text: '帮我看看这个报错' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先贴出日志。' }] } } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        calls += 1
        const payload = calls === 1
          ? '{"candidates":["我贴一下日志"]}'
          : '{"candidates":["我贴一下日志","顺便说下复现步骤","先看第 42 行附近"]}'
        yield { type: 'text-delta', text: payload }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    inject: (_deps, callback) => callback({
      effect: (fn) => { fn(); return () => {} },
      on: () => {},
      webServer: { register: (route) => { if (route.path === '/composer-quill/predict') globalThis.__topupRoute = route; return () => {} } },
      clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
    }),
  }
  host.apply(ctx)
  const route = globalThis.__topupRoute

  const call = () => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = () => {}
    res.end = (chunk) => resolve(JSON.parse(chunk))
    route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-topup', mode: 'next', draft: '' })))
    req.emit('end')
  })

  await checkAsync('a single candidate is topped up to a full set', async () => {
    const first = await call()
    assert.ok(first.candidates.length >= 2, JSON.stringify(first))
    assert.equal(calls, 2, 'a thin answer should trigger exactly one extra call')
  })
}

/** Two identical requests in flight must cost one model call. */
{
  let calls = 0
  const session = {
    id: 's-dedupe',
    snapshotEvents: () => ([
      { type: 'user/message', data: { content: [{ type: 'text', text: '之前的消息' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的' }] } } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 40))
        yield { type: 'text-delta', text: '，继续把剩下的部分贴上来。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    inject: (_deps, callback) => callback({
      effect: (fn) => { fn(); return () => {} },
      on: () => {},
      webServer: { register: (route) => { if (route.path === '/composer-quill/predict') globalThis.__dedupeRoute = route; return () => {} } },
      clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
    }),
  }
  host.apply(ctx)
  const route = globalThis.__dedupeRoute

  const call = () => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = () => {}
    res.end = (chunk) => resolve(chunk === undefined ? null : JSON.parse(chunk))
    route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-dedupe', mode: 'compose', draft: '帮我把这段日志' })))
    req.emit('end')
  })

  await checkAsync('identical concurrent requests share one model call', async () => {
    const [first, second] = await Promise.all([call(), call()])
    assert.equal(calls, 1, `model calls: ${calls}`)
    assert.ok(first?.text && second?.text, `${JSON.stringify(first)} / ${JSON.stringify(second)}`)
    assert.equal(first.text, second.text)
  })
}

// Two identical streaming requests must share one model call.
{
  let calls = 0
  const session = {
    id: 's-stream-dedupe',
    snapshotEvents: () => ([
      { type: 'user/message', data: { content: [{ type: 'text', text: '之前' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const ctx = {
    get: () => undefined,
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 30))
        yield { type: 'text-delta', text: '，继续贴剩下的日志。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    inject: (_deps, callback) => callback({
      effect: (fn) => { fn(); return () => {} },
      on: () => {},
      webServer: { register: (route) => { if (route.path === '/composer-quill/predict') globalThis.__streamRoute = route; return () => {} } },
      clientModules: { clientPath: () => '/tmp/x.js', graph: () => ({ entries: [] }) },
    }),
  }
  host.apply(ctx)
  const route = globalThis.__streamRoute

  const streamCall = () => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'sec-fetch-site': 'same-origin',
      'x-composer-quill-client': '1',
    }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.headersSent = true
    res.setHeader = () => {}
    res.flushHeaders = () => {}
    res.write = () => true
    res.end = () => resolve(true)
    route.handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-stream-dedupe', mode: 'compose', draft: '帮我把这段日志' })))
    req.emit('end')
  })

  await checkAsync('identical concurrent streams share one model call', async () => {
    await Promise.all([streamCall(), streamCall()])
    assert.equal(calls, 1, 'model calls: ' + calls)
  })
}

check('an answer from the model is never thrown away entirely', () => {
  const { parseCandidates, rankCandidates } = host.__test
  // A string where a list was expected is still usable.
  assert.deepEqual(parseCandidates('{"candidates":"先看日志"}'), ['先看日志'])
  // Filters may not empty the list: the raw answer survives.
  const filtered = rankCandidates(['Please paste the full stack trace here.', '另一个候选也不算短'], {
    profile: { language: 'zh', avgChars: 20, usesGreeting: false },
    lastAssistant: '没问题',
  })
  assert.ok(filtered.length > 0, 'every candidate was dropped')
  // Model commentary is still never offered.
  const metaOnly = rankCandidates(['The draft is already complete and sound.'], { profile: {}, lastAssistant: '' })
  assert.deepEqual(metaOnly, [])
})

check('a proposal already typed into the editor is stale', () => {
  const { proposalIsStale } = moduleExports.__test
  // The exact case from the report: the chip repeated the composer's own text.
  assert.equal(proposalIsStale('哪 5 条？先列出来我确认一下', '哪 5 条？先列出来我确认一下'), true)
  assert.equal(proposalIsStale('哪 5 条？先列出来我确认一 下', '哪 5 条？先列出来我确认一 下'), true)
  // A genuine continuation is not stale.
  assert.equal(proposalIsStale('里的报错信息提取出来', '帮我把这段日志'), false)
  assert.equal(proposalIsStale('看一下', ''), false)
  assert.equal(proposalIsStale('', '看一下'), false)
})

check('a stored suggestion from an older transcript is refused', () => {
  const { saveSuggestion, loadSuggestion, transcriptVersion } = moduleExports.__test
  window.localStorage.clear()
  saveSuggestion('s1', 'next', '', ['先把语言设置那段改完'], '3:120')
  assert.deepEqual(loadSuggestion('s1', 'next', '', '3:120'), ['先把语言设置那段改完'])
  // One more turn happened: the stored text is no longer about this conversation.
  assert.equal(loadSuggestion('s1', 'next', '', '5:180'), null)
  // The version is derived from the event list.
  assert.equal(transcriptVersion([{ type: 'user/message', seq: 4 }]), '1:4')
})

check('acceptance feedback reorders candidates, never invents them', () => {
  const { featuresOf, rankByLearning, recordOutcome, learningSummary } = moduleExports.__test
  window.localStorage.clear()

  const short = '贴一下日志'
  const long = '请把刚才那段报错的完整堆栈从头到尾贴出来，并且标出最先失败的那一行，这样我才能判断是依赖版本还是代码本身的问题'
  assert.equal(featuresOf(short, 'next').length, 'len:xs')
  assert.equal(featuresOf(long, 'next').length, 'len:l')
  assert.equal(featuresOf('，顺便看下版本', 'next').opener, 'open:punct')
  assert.equal(featuresOf('好的，我来看看', 'next').greeting, 'greet:yes')

  // Teach it: short suggestions get accepted, long ones get dismissed.
  for (let index = 0; index < 6; index += 1) {
    recordOutcome(featuresOf(short, 'next'), true)
    recordOutcome(featuresOf(long, 'next'), false)
  }
  const ranked = rankByLearning([long, short], 'next')
  assert.deepEqual(ranked, [short, long], JSON.stringify(ranked))

  // Same set, same membership: reordering must not drop or add candidates.
  assert.equal(ranked.length, 2)

  const summary = learningSummary()
  assert.equal(summary.accepted, 6, JSON.stringify(summary))
  assert.ok(summary.rate > 0.4 && summary.rate < 1, JSON.stringify(summary))
})

check('a truncated stream is reported as a failure', async () => {
  const { streamRoute } = moduleExports.__test
  const frames = [
    'event: start\ndata: {"mode":"append"}\n\n',
    'event: delta\ndata: {"text":"，帮我看看"}\n\n',
  ].map((frame) => new TextEncoder().encode(frame))
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined }
            return { done: false, value: frames[index++] }
          },
          async cancel() {},
        }
      },
    },
    async json() { throw new Error('not json') },
  })
  try {
    const seen = []
    await streamRoute('/composer-quill/predict', { sessionId: 's-trunc', draft: 'x' }, undefined, {
      start: () => seen.push('start'),
      delta: () => seen.push('delta'),
      error: (data) => seen.push('error:' + data.message),
    })
    assert.deepEqual(seen, ['start', 'delta', 'error:stream ended without a result'])
  } finally {
    globalThis.fetch = previousFetch
  }
})

check('streaming frames arrive in order and end with done', async () => {
  const { streamRoute } = moduleExports.__test
  const frames = [
    'event: start\ndata: {"mode":"full"}\n\n',
    'event: delta\ndata: {"text":"帮我看看"}\n\n',
    'event: delta\ndata: {"text":"这个报错是怎么回事。"}\n\n',
    'event: final\ndata: {"text":"帮我看看这个报错是怎么回事。","mode":"full"}\n\n',
    'event: done\ndata: {"mode":"full"}\n\n',
  ].map((frame) => new TextEncoder().encode(frame))

  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream; charset=utf-8' },
    body: {
      getReader() {
        let index = 0
        return {
          async read() {
            if (index >= frames.length) return { done: true, value: undefined }
            return { done: false, value: frames[index++] }
          },
          async cancel() {},
        }
      },
    },
    async json() { throw new Error('not json') },
  })
  try {
    const seen = []
    await streamRoute('/composer-quill/predict', { sessionId: 's-stream', draft: '帮我看看' }, undefined, {
      start: (data) => seen.push(`start:${data.mode}`),
      delta: (data) => seen.push(`delta:${data.text}`),
      final: (data) => seen.push(`final:${data.text}:${data.mode}`),
      done: (data) => seen.push(`done:${data.mode}`),
      error: (data) => seen.push(`error:${data.message}`),
    })
    assert.deepEqual(seen, [
      'start:full',
      'delta:帮我看看',
      'delta:这个报错是怎么回事。',
      'final:帮我看看这个报错是怎么回事。:full',
      'done:full',
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})

for (const off of disposers) off()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
