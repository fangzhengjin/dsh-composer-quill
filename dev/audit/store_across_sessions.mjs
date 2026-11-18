/** Does a stored suggestion survive a Session switch? */
import { pathToFileURL } from 'node:url'

const store = new Map()
const captured = {}
globalThis.window = {
  __ModuleLoader__: { load({ id, factory }) { captured.id = id; captured.factory = factory } },
  __DSH_COMPOSER_QUILL_TOKEN__: 'test-token',
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  },
}
globalThis.document = { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} }

await import(pathToFileURL('../../client.js').href)

class FakeComponent {
  constructor(props) { this.props = props }
  render() { return null }
  setState() {}
  forceUpdate() {}
}

const fakeReact = {
  Component: FakeComponent,
  PureComponent: FakeComponent,
  createElement: () => null,
  Fragment: 'fragment',
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}
const { __test } = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require(${name})`)
})
const { saveSuggestion, loadSuggestion, syncEpoch, epochOf } = __test

store.set('dsh.composer-quill.epoch', JSON.stringify({ 'sess-a': 2 }))
console.log('epoch(a) =', epochOf('sess-a'))

saveSuggestion('sess-a', 'next', '', ['把刚才那段报错的完整堆栈贴出来'], '0', 'full')
console.log('stored keys =', [...store.keys()].filter((key) => key.includes('suggestions')))
console.log('load in the same session  →', loadSuggestion('sess-a', 'next', '', '0'))
syncEpoch('sess-b')
console.log('after switching to b      →', loadSuggestion('sess-a', 'next', '', '0'))
syncEpoch('sess-a')
console.log('after switching back      →', loadSuggestion('sess-a', 'next', '', '0'))
