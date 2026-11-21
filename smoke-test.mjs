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
import { isAbsolute } from 'node:path'
import { homedir, tmpdir as tmpdirOf } from 'node:os'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// --- runner -----------------------------------------------------------------
// Zero dependencies on purpose: the suite has to run from a bare checkout, and
// in CI, with nothing but Node. --filter / --list exist because iterating on one
// behaviour should not mean reading sixty lines to find the failure.
const argv = process.argv.slice(2)
const filterArg = argv.find((arg) => arg.startsWith('--filter='))
const filter = filterArg === undefined ? null : new RegExp(filterArg.slice('--filter='.length), 'i')
const listOnly = argv.includes('--list')

let passed = 0
let failed = 0
let skipped = 0
let groupName = ''
const slow = []
const failures = [] // kept for the historical exit-code logic at the bottom

const matches = (name) => filter === null || filter.test(name)

const record = (name, ok, detail, ms) => {
  if (!groupPrinted) {
    groupPrinted = true
    console.log(`\n${groupName}`)
  }
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}  (${ms.toFixed(1)}ms)`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`  FAIL ${name}: ${detail}`)
  }
  slow.push({ name, ms })
}

let groupPrinted = false
const group = (name) => {
  groupName = name
  groupPrinted = false
}

const check = (name, fn) => {
  if (listOnly) { console.log(`${groupName} :: ${name}`); return }
  if (!matches(name)) { skipped += 1; return }
  const started = performance.now()
  try {
    fn()
    record(name, true, '', performance.now() - started)
  } catch (error) {
    record(name, false, error.message, performance.now() - started)
  }
}

const checkAsync = async (name, fn) => {
  if (listOnly) { console.log(`${groupName} :: ${name}`); return }
  if (!matches(name)) { skipped += 1; return }
  const started = performance.now()
  try {
    await fn()
    record(name, true, '', performance.now() - started)
  } catch (error) {
    record(name, false, error.message, performance.now() - started)
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- Host half
group('host: pure helpers')
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
group('host: routes and streaming')

check('input hygiene normalises what came out of a terminal', () => {
  const { cleanLine, isPunctuationOnly, scriptOf, latinShareOf } = host.__test
  // cleanLine collapses whitespace, strips a list marker and surrounding quotes.
  assert.equal(cleanLine('  帮我把这段   日志\n\n整理一下  '), '帮我把这段 日志 整理一下')
  assert.equal(cleanLine('- 看看这个报错'), '看看这个报错')
  assert.equal(cleanLine('2) "继续补写"'), '继续补写')
  // An empty line yields null, not an empty string: callers test for null.
  assert.equal(cleanLine('   '), null)
  assert.equal(cleanLine(null), null)
  // Punctuation-only lines carry no request.
  assert.equal(isPunctuationOnly('。。。'), true)
  assert.equal(isPunctuationOnly('……！'), true)
  assert.equal(isPunctuationOnly('   '), true)
  assert.equal(isPunctuationOnly('继续'), false)
  // scriptOf returns a coarse label, latinShareOf a ratio.
  assert.equal(scriptOf('帮我把这段日志整理一下'), 'zh')
  assert.equal(scriptOf('please tidy this log'), 'en')
  // Latin outweighs CJK here, so this reads as English: the label is coarse on purpose.
  assert.equal(scriptOf('帮我看 dsh-composer-quill 的报错'), 'en')
  assert.equal(scriptOf('帮我把 abc'), 'mixed')
  assert.equal(scriptOf(''), 'none')
  assert.equal(latinShareOf('全部是中文'), 0)
  assert.equal(latinShareOf('only english here'), 1)
  const mixed = latinShareOf('dsh-composer-quill 的缓存键')
  assert.ok(mixed > 0 && mixed < 1, String(mixed))
})

check('the on-disk cache is inert in tests and knows where it lives', () => {
  const { cacheFile, loadCache } = host.__test
  // DSH_COMPOSER_QUILL_NO_CACHE=1 is set by this suite: loadCache returns 0 entries,
  // so a test run can never hand a stale answer to the next one.
  assert.equal(loadCache(), 0)
  // The path follows the host's own directory, so assert the contract rather than
  // one machine's layout: an absolute path ending with the cache filename.
  const file = cacheFile()
  assert.ok(file.endsWith('composer-quill-cache.json'), file)
  assert.ok(isAbsolute(file), file)
  assert.ok(file.startsWith(process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? homedir()), file)
})


check('the language gate only fires on a clear mismatch', () => {
  const { wrongLanguage } = host.__test
  // A Chinese user pasting a Latin identifier must not be judged English.
  assert.equal(wrongLanguage('帮我看看 dsh-composer-quill 的缓存', 'zh'), false)
  assert.equal(wrongLanguage('the draft is already complete, nothing to add', 'zh'), true)
  // English setting, Chinese candidate: clearly the wrong language.
  assert.equal(wrongLanguage('这里应该继续补写', 'en'), true)
  assert.equal(wrongLanguage('continue with the cache key', 'en'), false)
  // Short text carries no language signal either way.
  assert.equal(wrongLanguage('ok', 'zh'), false)
  assert.equal(wrongLanguage('继续', 'en'), false)
  // No opinion means no gate.
  assert.equal(wrongLanguage('anything at all here', ''), false)
})

check('the language setting outranks the locale', () => {
  const { resolveLanguage } = host.__test
  assert.equal(resolveLanguage({ locale: 'en-US', forced: 'zh' }), 'zh')
  assert.equal(resolveLanguage({ locale: 'zh-CN', forced: 'en' }), 'en')
  assert.equal(resolveLanguage({ locale: 'zh-CN', forced: 'auto' }), 'zh')
  assert.equal(resolveLanguage({ locale: 'en-GB' }), 'en')
  assert.equal(resolveLanguage({ locale: 'fr-FR' }), '')
})

check('eventsOf picks the longest event list the session exposes', () => {
  const { eventsOf } = host.__test
  const snapshot = [{ seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }]
  const own = [{ seq: 3, type: 'user/message' }]
  // The snapshot is longer, so it wins: mixing sources would duplicate rows.
  assert.deepEqual(eventsOf({ snapshotEvents: () => snapshot, ownEvents: () => own }), snapshot)
  assert.deepEqual(eventsOf({ snapshotEvents: () => own, ownEvents: () => snapshot }), snapshot)
  // A throwing accessor must not hide the others.
  assert.deepEqual(
    eventsOf({ snapshotEvents: () => { throw new Error('nope') }, ownEvents: () => own }),
    own,
  )
  // A session that exposes nothing yields an empty list, never undefined.
  assert.deepEqual(eventsOf(null), [])
  assert.deepEqual(eventsOf({}), [])
})

check('a one-character draft is asked for a full short sentence', () => {
  const { buildShortDraftPrompt } = host.__test
  const prompt = buildShortDraftPrompt({
    draft: '帮',
    context: '[]',
    digest: null,
    assistant: '',
    style: null,
    language: 'zh',
  })
  assert.ok(prompt.includes('"帮"'), 'the draft must be quoted into the prompt')
  assert.ok(/3 to 20/.test(prompt), 'the answer length must be spelled out')
  assert.ok(prompt.includes('Chinese'), 'the language setting must reach the prompt')
  assert.ok(/not generic filler/.test(prompt), 'the filler ban is what stops "帮我。"')
})
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

check('a short draft gets a real tail when one exists', () => {
  const { parseComposeReply } = host.__test
  // Three characters of genuine continuation are kept (that is the ghost text).
  const tail = parseComposeReply('看一下吧。', '再', { allowTail: true, minTail: 3 })
  assert.equal(tail?.mode, 'append')
  assert.equal(tail?.text, '再看一下吧。')
  // A fragment below the minimum is refused.
  assert.equal(parseComposeReply('我。', '帮', { allowTail: true, minTail: 3 }), null)
  // A rewrite still works when the draft cannot be continued.
  const rewrite = parseComposeReply('REWRITE: 帮我把日志整理一下', '帮', { allowTail: true, minTail: 3 })
  assert.equal(rewrite?.mode, 'full')
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

check('a topic from an hour ago cannot be pulled back into the window', () => {
  const { transcriptOf } = host.__test
  const events = []
  // Turns 1-6: the old topic (an hour ago in a real session).
  for (let turn = 1; turn <= 6; turn += 1) {
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${turn}轮：改名之后旧链接会重定向吗，LINKCHECK` }] } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${turn}轮回答：会重定向，GitHub 会保留 301。` }] } } })
  }
  // Turns 7-30: the current topic. Same length, no overlap with the old one.
  for (let turn = 7; turn <= 30; turn += 1) {
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${turn}轮：继续改 composer-quill 的缓存键与回合计数` }] } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${turn}轮回答：回合计数进键即可让旧结果失效。` }] } } })
  }
  // A draft that happens to share wording with the old topic must not resurrect it.
  const context = transcriptOf(events, { rows: 10, chars: 3200, focus: '再谈一下改名重定向' })
  const rows = JSON.parse(context)
  const old = rows.filter((row) => row.text.includes('LINKCHECK'))
  const newest = rows.slice(-2).map((row) => row.text).join(' ')
  assert.ok(rows.length <= 10, 'window stays bounded: ' + rows.length)
  assert.equal(old.length, 0, 'an old topic must stay out of the prompt: ' + JSON.stringify(old))
  assert.ok(/第29轮|第30轮/.test(newest), 'the newest turns must be present: ' + newest.slice(0, 60))
})

check('a recent topic the draft mentions is still pulled in', () => {
  const { transcriptOf, sessionDigest } = host.__test
  const events = []
  for (let turn = 1; turn <= 30; turn += 1) {
    // The CSV topic sits at turns 24-26: recent enough to earn a backfill slot.
    const csv = turn >= 20 && turn <= 22
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: `第${turn}轮：${csv ? '请帮我看一下 CSV 导出脚本的时区问题' : '帮我看看这个前端报错怎么修'}，编号 ${turn}` }] } })
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第${turn}轮回答：${csv ? '时区问题通常是 UTC 与本地时间混用导致的。' : '前端问题通常和依赖版本有关。'} ` }] } } })
  }
  const draft = '再帮我看下 CSV 导出的时区'
  const plain = transcriptOf(events, { rows: 10, chars: 3200 })
  const focused = transcriptOf(events, { rows: 10, chars: 3200, focus: draft })
  assert.equal((plain.match(/CSV/g) ?? []).length, 0, 'without focus the topic is out of the window')
  assert.ok((focused.match(/CSV/g) ?? []).length >= 1, 'a recent topic must still be pulled in')
  assert.ok(focused.length <= 3400, `window grew too much: ${focused.length}`)

  // The opening request is the oldest thing in the session: drop it once the
  // conversation has moved on, keep it while it still describes the topic.
  const longDigest = sessionDigest(events)
  assert.equal(longDigest.openingRequest, undefined, JSON.stringify(longDigest))
  assert.equal(longDigest.latestUserMessages.length, 3)
  const shortDigest = sessionDigest(events.slice(-16))
  assert.ok(shortDigest.openingRequest !== undefined, 'a short session keeps its opening request')
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
group('client: factory, slots, requests')

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

  // An hour old is still the same conversation state, so it is still reused.
  const map = JSON.parse(window.localStorage.getItem('dsh.composer-quill.suggestions'))
  for (const key of Object.keys(map)) map[key].at = Date.now() - 60 * 60_000
  window.localStorage.setItem('dsh.composer-quill.suggestions', JSON.stringify(map))
  assert.deepEqual(
    loadSuggestion('s-a', 'next', ''),
    ['继续看下去', '换个思路'],
    'an hour-old suggestion for an unchanged conversation must be reused',
  )
  // Beyond the storage horizon it is dropped.
  const stale = JSON.parse(window.localStorage.getItem('dsh.composer-quill.suggestions'))
  for (const key of Object.keys(stale)) stale[key].at = Date.now() - 25 * 60 * 60_000
  window.localStorage.setItem('dsh.composer-quill.suggestions', JSON.stringify(stale))
  assert.equal(loadSuggestion('s-a', 'next', ''), null, 'a day-old entry is storage-expired')

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
  assert.deepEqual(normalizeConfig(null), { enabled: true, mode: 'auto', language: 'auto', debounceMs: 120, timeoutMs: 20000 })
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
    config: { subscribe: () => () => {}, getSnapshot: () => ({ enabled: true, mode: 'auto', debounceMs: 120, timeoutMs: 20000 }), set: () => {} },
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

check('a request in flight keeps covering a draft that only grew', () => {
  const { inFlightCovers } = moduleExports.__test
  // The measured failure: first delta lands ~1.9 s after the request, and every
  // keystroke used to cancel the request that was about to produce the ghost.
  assert.equal(inFlightCovers('帮我把这段', '帮我把这段构建日志'), true)
  assert.equal(inFlightCovers('帮我把这段', '帮我把这段'), true)
  // Shrunk: the tail no longer belongs to this draft.
  assert.equal(inFlightCovers('帮我把这段构建日志', '帮我把这段'), false)
  // Diverged mid-way: the in-flight tail can no longer be pasted.
  assert.equal(inFlightCovers('帮我把这段', '帮我把那份'), false)
  // Nothing to cover.
  assert.equal(inFlightCovers('', '帮我把这段'), false)
  assert.equal(inFlightCovers(null, '帮我把这段'), false)
  assert.equal(inFlightCovers('帮我把这段', null), false)
})

check('the turn counter is per session and survives a session switch', () => {
  const { epochOf, bumpEpoch, syncEpoch } = moduleExports.__test
  window.localStorage.clear()
  assert.equal(epochOf('session-a'), 0)
  assert.equal(bumpEpoch('session-a'), 1)
  assert.equal(bumpEpoch('session-a'), 2)
  // Another session keeps its own count.
  assert.equal(epochOf('session-b'), 0)
  assert.equal(epochOf('session-a'), 2)
  // Switching away and back adopts the stored value instead of resetting it.
  assert.equal(syncEpoch('session-b'), 0)
  assert.equal(syncEpoch('session-a'), 2)
  assert.equal(syncEpoch('session-a'), 2, 'a repeat call must not re-read or reset')
  // The count continues from the stored value after a switch.
  assert.equal(bumpEpoch('session-a'), 3)
  window.localStorage.clear()
})

check('the transcript stamp changes only when the tail does', () => {
  const { transcriptVersion } = moduleExports.__test
  const first = transcriptVersion([{ seq: 1 }, { seq: 2 }])
  assert.equal(transcriptVersion([{ seq: 1 }, { seq: 2 }]), first)
  assert.notEqual(transcriptVersion([{ seq: 1 }, { seq: 3 }]), first)
  assert.notEqual(transcriptVersion([{ seq: 1 }, { seq: 2 }, { seq: 3 }]), first)
  assert.equal(transcriptVersion([]), '0')
})
check('stored suggestions can be listed and cleared per session', () => {
  const { saveSuggestion, readSuggestions, clearSessionSuggestions } = moduleExports.__test
  window.localStorage.clear()
  saveSuggestion('session-x', 'compose', '帮我把这段', ['日志整理一下'], '1', 'append')
  saveSuggestion('session-y', 'next', '', ['继续'], '1', 'full')
  const all = readSuggestions()
  assert.ok(Object.keys(all).length >= 2, JSON.stringify(all))
  clearSessionSuggestions('session-x')
  const after = readSuggestions()
  const keysAfter = JSON.stringify(after)
  assert.equal(keysAfter.includes('session-x'), false, 'session-x entries must be gone')
  window.localStorage.clear()
})

check('the turn counter, not the message count, decides reuse', () => {
  const { saveSuggestion, loadSuggestion, bumpEpoch, syncEpoch } = moduleExports.__test
  window.localStorage.clear()
  window.localStorage.removeItem('dsh.composer-quill.epoch')

  saveSuggestion('s1', 'next', '', ['先把语言设置那段改完'], '3', 'full')
  // Same turn: reusable even though the caller has a different message count
  // (that count is fetched asynchronously and lags behind a Session switch).
  assert.deepEqual(loadSuggestion('s1', 'next', ''), ['先把语言设置那段改完'])
  // A finished turn invalidates it.
  syncEpoch('s1')
  bumpEpoch('s1')
  assert.equal(loadSuggestion('s1', 'next', ''), null)
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

// ------------------------------------------------- independent audit findings
group('client: audit findings')
// A long stream used to add one abort listener per chunk (83 on 80 chunks).
{
  let peak = 0
  const counts = new WeakMap()
  const originalAdd = AbortSignal.prototype.addEventListener
  const originalRemove = AbortSignal.prototype.removeEventListener
  AbortSignal.prototype.addEventListener = function add(type, fn, options) {
    if (type === 'abort') {
      const size = (counts.get(this) ?? 0) + 1
      counts.set(this, size)
      if (size > peak) peak = size
    }
    return originalAdd.call(this, type, fn, options)
  }
  AbortSignal.prototype.removeEventListener = function remove(type, fn, options) {
    if (type === 'abort') counts.set(this, Math.max(0, (counts.get(this) ?? 0) - 1))
    return originalRemove.call(this, type, fn, options)
  }
  try {
    const session = {
      id: 's-listeners',
      snapshotEvents: () => ([
        { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我看下这个报错' }] } },
        { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '先贴日志。' }] } } },
      ]),
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    }
    const routes = {}
    const ctx = {
      agents: { get: () => ({ session }) },
      llm: {
        async *stream() {
          for (let index = 0; index < 60; index += 1) yield { type: 'text-delta', text: '字' }
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
    host.apply(ctx)
    await checkAsync('one abort listener per model call, not per chunk', async () => {
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
        routes['/composer-quill/predict'].handler(req, res)
        req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-listeners', mode: 'next', draft: '' })))
        req.emit('end')
      })
      assert.ok(peak <= 3, 'abort listeners peaked at ' + peak)
    })
  } finally {
    AbortSignal.prototype.addEventListener = originalAdd
    AbortSignal.prototype.removeEventListener = originalRemove
  }
}

// Nothing changed, time passed: still one model call.
{
  let calls = 0
  const session = {
    id: 's-steady',
    snapshotEvents: () => ([
      { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我看下这个报错' }] } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '先贴日志。' }] } } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const routes = {}
  const ctx = {
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        calls += 1
        yield { type: 'text-delta', text: '{"candidates":["贴一下第 3 行日志"]}' }
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
  host.apply(ctx)
  const call = () => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = () => {}
    res.end = (chunk) => resolve(JSON.parse(String(chunk)))
    routes['/composer-quill/predict'].handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-steady', mode: 'next', draft: '', epoch: 3 })))
    req.emit('end')
  })
  await checkAsync('an unchanged conversation is never re-sampled', async () => {
    await call()
    const first = calls
    await wait(2500)
    await call()
    await wait(500)
    await call()
    assert.equal(calls, first, 'model calls grew from ' + first + ' to ' + calls)
  })
}

// A finished turn must invalidate the Host cache even when its transcript lags.
{
  let calls = 0
  const session = {
    id: 's-epoch',
    // A host whose snapshot never grows: the epoch is the only thing that changes.
    snapshotEvents: () => ([
      { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: '帮我看下这个报错' }] } },
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: '先贴日志。' }] } } },
    ]),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const routes = {}
  const ctx = {
    agents: { get: () => ({ session }) },
    llm: {
      async *stream() {
        calls += 1
        yield { type: 'text-delta', text: '{"candidates":["再看下第 3 个报错"]}' }
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
  host.apply(ctx)
  const call = (epoch) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = () => {}
    res.end = (chunk) => resolve(JSON.parse(String(chunk)))
    routes['/composer-quill/predict'].handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-epoch', mode: 'next', draft: '', epoch })))
    req.emit('end')
  })
  await checkAsync('a new turn is never served from the previous turn cache', async () => {
    await call(4)
    const afterFirst = calls
    await call(5)
    assert.ok(calls > afterFirst, 'model calls stayed at ' + calls)
    // Same epoch still reuses the answer.
    const before = calls
    await call(5)
    assert.equal(calls, before, 'same turn should reuse the cached candidates')
  })
}

// The language setting changes no Session event, so it must be part of the cache key.
{
  let calls = 0
  const session = {
    id: 's-cache-lang',
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
        calls += 1
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
  host.apply(ctx)
  const call = (language) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-composer-quill-client': '1' }
    const res = new EventEmitter()
    res.statusCode = 0
    res.writableEnded = false
    res.destroyed = false
    res.setHeader = () => {}
    res.end = (chunk) => resolve(JSON.parse(String(chunk)))
    routes['/composer-quill/predict'].handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ sessionId: 's-cache-lang', mode: 'compose', draft: '帮我把日志', language })))
    req.emit('end')
  })
  await checkAsync('switching the language setting is not served from cache', async () => {
    await call('auto')
    const afterFirst = calls
    await call('en')
    assert.ok(calls > afterFirst, 'model calls stayed at ' + calls)
  })
}

for (const off of disposers) off()


const elapsed = slow.reduce((total, entry) => total + entry.ms, 0)
const worst = [...slow].sort((left, right) => right.ms - left.ms).slice(0, 3)

group('host: security')

{
  const api = host.__test
  const req = (headers) => ({ headers })

  check('a rebound Host cannot ride the header path', () => {
    assert.equal(
      api.authorized(req({
        host: 'evil.example:58537',
        'sec-fetch-site': 'same-origin',
        'x-composer-quill-client': '1',
        'content-type': 'application/json',
      }), 'the-real-token'),
      false,
    )
  })

  check('a loopback page still may', () => {
    assert.equal(
      api.authorized(req({
        host: '127.0.0.1:58537',
        'sec-fetch-site': 'same-origin',
        'x-composer-quill-client': '1',
        'content-type': 'application/json',
      }), 'the-real-token'),
      true,
    )
  })

  check('isLoopbackHost knows the loopback spellings', () => {
    for (const value of ['127.0.0.1:1', 'localhost:58537', '[::1]:58537', 'localhost']) {
      assert.equal(api.isLoopbackHost(value), true, value)
    }
    for (const value of ['evil.example', '10.0.0.5:80', '']) {
      assert.equal(api.isLoopbackHost(value), false, value)
    }
  })

  check('the session digest leaves with secrets masked', () => {
    const digest = api.sessionDigest([
      { type: 'user/message', data: { content: [{ type: 'text', text: '我的 key 是 sk-abcdef1234567890' }] } },
    ])
    assert.equal(digest.latestUserMessages[0].includes('sk-abcdef'), false)
    assert.equal(digest.latestUserMessages[0].includes('[redacted'), true)
  })

  check('the last assistant reply leaves masked too', () => {
    const text = api.lastAssistantText([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `你贴的 ghp_${'a'.repeat(36)} 要撤销` }] } } },
    ])
    assert.equal(text.includes('ghp_abcdefghij'), false)
  })
}

group('host: fixes')

{
  const api = host.__test

  check('a backfilled row keeps its chronological place', () => {
    const events = []
    for (let i = 1; i <= 30; i += 1) {
      const text = i === 22 ? 'CSV 导出时区错了' : '第 ' + i + ' 轮：帮我看下这个日志'
      events.push({ type: 'user/message', seq: i * 2, data: { content: [{ type: 'text', text }] } })
      events.push({ type: 'assistant/message', seq: i * 2 + 1, data: { message: { content: [{ type: 'text', text: '回答 ' + i }] } } })
    }
    const rows = JSON.parse(api.transcriptOf(events, { rows: 6, chars: 4000, focus: 'CSV 导出时区' }))
    const last = rows[rows.length - 1].text
    assert.equal(last.includes('CSV 导出'), false, JSON.stringify(rows.map((row) => row.text.slice(0, 12))))
    assert.equal(/回答 30|第 30 轮/.test(last), true)
  })

  check('a JSON shell becomes a message, not literal syntax', () => {
    for (const reply of ['{"text":"再贴一下完整栈"}', '{"text": "再贴一下完整栈"}']) {
      const parsed = api.parseComposeReply(reply, '帮我看下这个报错')
      if (parsed !== null) assert.equal(parsed.text.includes('{"text"'), false, reply)
    }
  })

  check('a truncated JSON reply yields no candidates', () => {
    assert.deepEqual(api.parseCandidates('{"candidates":["先固定 auth 最不稳'), [])
  })

  check('the cache key carries the masked draft, not the raw one', () => {
    const key = api.cacheKey('session-1', 'next', '我的 key 是 sk-abcdef1234567890', [], { provider: 'p', model: 'm' }, 'zh', 1)
    assert.equal(key.includes('sk-abcdef'), false)
    assert.equal(key.includes('[redacted'), true)
  })
}


group('host: compose prompt')

{
  const api = host.__test
  const base = {
    draft: '帮我把这段日志整理一下',
    context: '[]',
    digest: { latestUserMessages: ['你好'] },
    style: { count: 3, avgChars: 12, language: 'zh' },
    assistant: '好的',
    settingLanguage: 'zh',
  }

  check('one prompt carries every part both transports need', () => {
    const prompt = api.composePrompt(base)
    assert.equal(prompt.includes('Conversation digest'), true)
    assert.equal(prompt.includes('Style profile'), true)
    assert.equal(prompt.includes('latest assistant reply'), true)
  })

  check('the prompt is a pure function of its inputs', () => {
    assert.equal(api.composePrompt(base), api.composePrompt({ ...base }))
  })

  check('an unknown locale does not claim Chinese', () => {
    const prompt = api.composePrompt({ ...base, settingLanguage: '' })
    assert.equal(prompt.includes("the user's language"), true)
    assert.equal(prompt.includes('this is the user\'s language setting, so the completion'), true)
  })

  check('a cross-language draft asks for the Case B translation', () => {
    const prompt = api.composePrompt({ ...base, draft: '帮我把这段日志整理一下', settingLanguage: 'en' })
    assert.equal(prompt.includes('REWRITE:'), true)
    assert.equal(prompt.includes('translated into English'), true)
  })

  check('a very short draft takes the finish-it branch', () => {
    const prompt = api.composePrompt({ ...base, draft: '帮' })
    assert.equal(prompt.includes('characters. Finish it'), true)
  })
}


  if (listOnly) process.exit(0)

group('client: items')

{
  const api = globalThis.__ghostFactory.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require(${name})`)
  }).__test

  check('a suggestion list keeps only non-empty strings', () => {
    assert.deepEqual(api.usableItems(['整理一下', '', 3, null, '再看日志']), ['整理一下', '再看日志'])
  })

  check('anything that is not an array yields nothing', () => {
    for (const value of [undefined, null, 'text', 42]) {
      assert.deepEqual(api.usableItems(value), [], String(value))
    }
  })
}


group('host: cache window')

{
  const api = host.__test

  check('the window is two minutes', () => {
    assert.equal(api.CACHE_TTL_MS, 120_000)
    assert.equal(api.CACHE_CAPACITY, 64)
  })

  check('an entry older than the window is stale', () => {
    const now = Date.now()
    assert.equal(api.fresh({ at: now - 60_000 }, now), true)
    assert.equal(api.fresh({ at: now - 3 * 60_000 }, now), false)
    // A negative result sets its own, shorter window.
    assert.equal(api.fresh({ at: now - 20_000, ttl: 10_000 }, now), false)
  })

  check('a hit survives the next eviction', () => {
    process.env.DSH_COMPOSER_QUILL_NO_CACHE = '1'
    const first = 'test-hot-key'
    api.remember(first, { kind: 'compose', text: 'hot' })
    for (let i = 0; i < api.CACHE_CAPACITY - 1; i += 1) {
      api.remember('test-cold-' + i, { kind: 'compose', text: 'cold' + i })
    }
    // Touch the oldest entry, then push one new one over the cap.
    assert.equal(api.cached(first)?.text, 'hot')
    api.remember('test-newcomer', { kind: 'compose', text: 'new' })
    assert.equal(api.cached(first)?.text, 'hot')
    delete process.env.DSH_COMPOSER_QUILL_NO_CACHE
  })

  check('history rows carry the event time', () => {
    const at = 1763000000000
    const rows = api.historyOf([
      { type: 'user/message', time: at, data: { content: [{ type: 'text', text: '先看日志' }] } },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].at, new Date(at).toISOString())
  })
}


group('host: preflight')

{
  const api = host.__test
  const answer = () => {
    const seen = { status: 0, headers: {}, body: null }
    return {
      seen,
      res: {
        setHeader: (name, value) => { seen.headers[name] = value },
        end: (payload) => {
          seen.body = typeof payload === 'string' ? payload : null
          seen.written = true
        },
        writableEnded: false,
        statusCode: 0,
      },
    }
  }
  const token = 'the-real-token'

  check('a non-POST is refused with 405', () => {
    const { seen, res } = answer()
    const ok = api.preflight({ method: 'GET', headers: {} }, res, token, { label: 'predict' })
    assert.equal(ok, false)
    assert.equal(seen.headers.allow, 'POST')
  })

  check('a POST without a token is refused', () => {
    const { res } = answer()
    const ok = api.preflight({ method: 'POST', headers: {} }, res, token, { label: 'predict' })
    assert.equal(ok, false)
  })

  check('the token opens the route', () => {
    const { res } = answer()
    const ok = api.preflight({ method: 'POST', headers: { 'x-composer-quill-token': token } }, res, token, { label: 'predict' })
    assert.equal(ok, true)
  })

  check('a token-only route ignores the header shortcut', () => {
    const { res } = answer()
    const ok = api.preflight(
      {
        method: 'POST',
        headers: {
          host: '127.0.0.1:1',
          'sec-fetch-site': 'same-origin',
          'x-composer-quill-client': '1',
          'content-type': 'application/json',
        },
      },
      res,
      token,
      { tokenOnly: true, label: 'history' },
    )
    assert.equal(ok, false)
  })
}


const summary = [
  '',
  `${passed} passed`,
  failed === 0 ? '' : `${failed} failed`,
  skipped === 0 ? '' : `${skipped} skipped (--filter)`,
  `${elapsed.toFixed(0)}ms total`,
].filter(Boolean).join(', ')
console.log(summary)
if (failed > 0) {
  console.log('slowest: ' + worst.map((entry) => `${entry.name} (${entry.ms.toFixed(0)}ms)`).join(' · '))
  for (const name of failures) console.log('  failed: ' + name)
}
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)



