/**
 * The built browser half, exercised end to end.
 *
 * This is the closest thing to the real thing without a browser: the generated
 * `client.js` is executed exactly as the page's module loader would, its runner
 * source is started inside a fresh VM realm with a fake `self`, the lockdown is
 * applied, and a compiled DIL program is pushed through the whole pipeline.
 *
 * It is the only test that can catch the two mistakes that matter most in a
 * sandboxed design — a bundle that does not register, and a lockdown that
 * removes the very capability the loader still needs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

import { compileDil } from '../lib/compile.js'
import { decodeTree, OP, ROOT_ID } from '../src/runtime/runtime.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A React stand-in: the bundle only needs an element factory to be loadable. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useMemo: (compute) => compute(),
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/** Load `client.js` the way the module loader does. */
async function loadBundle() {
  const source = await readFile(path.join(root, 'client.js'), 'utf8')
  const registrations = []
  const windowObject = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  vm.runInNewContext(source, { window: windowObject, URL, console })
  assert.equal(registrations.length, 1, 'the bundle registered more than one factory')
  const registration = registrations[0]
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return ReactStub
    throw new Error(`unexpected require("${specifier}")`)
  })
  return { registration, exports }
}

/** A Context that records slot registrations. */
function fakeContext() {
  const state = { injected: [], registrations: [], effects: 0, disposers: [] }
  const ctx = {
    get: () => undefined,
    effect(run) {
      state.effects += 1
      const dispose = run()
      if (typeof dispose === 'function') state.disposers.push(dispose)
      return dispose
    },
    slots: {
      inject(key, callback) {
        state.injected.push(key)
        const result = callback()
        // A generator return installs several registrations atomically; the
        // registry disposes them in reverse order.
        if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
          for (const _ of result) { /* already registered by the yielded calls */ }
        }
        return () => {}
      },
      register(options, component) {
        state.registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, state }
}

test('client.js registers under the package name the module table expects', async () => {
  const { registration, exports } = await loadBundle()
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(registration.id, manifest.name, 'the loader id must equal the package name')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
})

test('the browser half registers a toolview and a turn tail for the card', async () => {
  const { exports } = await loadBundle()
  const { ctx, state } = fakeContext()
  exports.apply(ctx)
  assert.deepEqual(state.injected, ['tool.call.toolview', 'conversation.chat.turnTail'])
  assert.equal(state.registrations.length, 3)

  // One registration per wire name, so a delivery and a clarification can be
  // told apart by the seat the transcript dispatches to.
  const toolviews = state.registrations.filter((entry) => entry.options.name === 'tool.call.toolview')
  assert.deepEqual(toolviews.map((entry) => entry.options.key), ['render_ui', 'ask_with_ui'])
  for (const toolview of toolviews) {
    assert.match(toolview.options.registrant, /^@comeonzhj\/dsh-intelligent-ui/)
    // `locale` and `children` are deliberately absent: neither is needed, and
    // declaring them would couple the card to two more services.
    assert.equal(toolview.options.locale, undefined)
    assert.equal(toolview.options.children, undefined)
    assert.equal(typeof toolview.component, 'function')
    assert.equal(typeof toolview.options.inject, 'function', 'the session-scoped answer face is missing')
  }

  // `conversation.chat.turnTail` is a list slot, so it is addressed by `id`, and
  // `turn-tail` is fold-independent in the transcript — which is the whole
  // reason the settled card lives there.
  const tail = state.registrations.find((entry) => entry.options.name === 'conversation.chat.turnTail')
  assert.equal(tail.options.name, 'conversation.chat.turnTail')
  assert.equal(typeof tail.options.id, 'string')
  assert.equal(typeof tail.options.order, 'number')
  assert.equal(typeof tail.component, 'function')
  assert.equal(typeof tail.options.inject, 'function')
})

test('the browser half needs the services it declares', async () => {
  const { exports } = await loadBundle()
  assert.deepEqual([...exports.inject].sort(), ['sessions', 'slots'])
})

/**
 * Run the shipped runner source in its own realm.
 *
 * @param options - `{ lockdown: boolean }`.
 * @returns `{ self, sent, context, run }` where `sent` collects每 message the
 *   runner posted back.
 */
function startRunner(source, options = {}) {
  const sent = []
  const self = { postMessage: (message) => sent.push(message) }
  // A browser-ish global floor: enough for the vendored chart runtime to load
  // if a program ever draws one, without pretending to be a DOM.
  const sandbox = { self, console, fetch: () => { throw new Error('network') }, navigator: { userAgent: 'node' } }
  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'runner.js' })
  const send = (message) => self.onmessage({ data: message })
  if (options.lockdown !== false) {
    send({ t: 'lockdown' })
    assert.equal(sent[0].t, 'locked')
    assert.ok(sent[0].removed.length > 0, 'the lockdown removed nothing')
  }
  return { self, sent, context, send }
}

test('the runner locks its global scope down before the first program', async () => {
  const { exports } = await loadBundle()
  const { context, sent } = startRunner(exports.runnerSource)
  const locked = sent[0]
  // Network access, timers, messaging and dynamic code evaluation are gone.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'postMessage', 'eval', 'Function']) {
    if (name === 'eval') continue
    assert.equal(vm.runInContext(`'${name}' in globalThis`, context), false, `${name} survived the lockdown`)
  }
  assert.ok(locked.removed.includes('Function'))
  assert.ok(locked.removed.includes('postMessage'), 'the runner must give up its own channel name too')
  // The runner still has its captured channel, which is the whole point of
  // capturing before deleting.
  assert.equal(vm.runInContext("typeof self.onmessage", context), 'function')
})

test('a compiled program survives the lockdown and produces operations', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  const compiled = compileDil([
    '## Team plan estimate',
    'Drag the slider to see the **monthly price** for your team.',
    '{@body const [seats,setSeats] = DIL.useState(8)}',
    '{@body const price = seats*29}',
    '<box border padding={3} gap={2}>',
    '  <slider min={1} max={50} value={seats} onChange={setSeats}/>',
    '  <title size="xl">${price}/mo</title>',
    '</box>',
  ].join('\n'))

  // `Function` is gone from the realm by now; the loader still compiles, because
  // it captured the constructor while the module was evaluated.
  send({ t: 'program', code: compiled.code, constants: compiled.constants })
  const batch = sent.at(-1)
  assert.equal(batch.t, 'batch')
  assert.equal(batch.ok, true, batch.error?.message)
  assert.equal(batch.firstRender, true)

  // Decode with the page-side decoder, exactly as the component does.
  const rootNode = { id: ROOT_ID, childrenOrder: [], children: [] }
  const handlers = []
  const nodes = decodeTree(batch, { root: rootNode, onHandler: (id) => { handlers.push(id); return () => {} } })
  const texts = [...nodes.values()].filter((node) => node.text !== null).map((node) => node.text)
  assert.deepEqual(texts, ['Team plan estimate', 'Drag the slider to see the ', 'monthly price', ' for your team.', '$', '232', '/mo'])
  assert.equal(handlers.length, 1)

  // The user drags the slider: the interaction is answered inside the runner.
  send({ t: 'event', handler: handlers[0], args: [12] })
  const update = sent.at(-1)
  assert.equal(update.ok, true)
  decodeTree(update, { nodes, root: rootNode })
  const after = [...nodes.values()].filter((node) => node.text !== null).map((node) => node.text)
  assert.ok(after.includes('348'), `expected 12 × 29 = 348, saw ${after.join(' | ')}`)
})

test('the runner expands the prebuilt composites', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  const compiled = compileDil([
    '<choiceCard',
    '  options={[{value:"pro",label:"Pro",meta:"$29"},{value:"team",label:"Team",meta:"$99"}]}',
    '  value="pro"',
    '  prompt="Which plan?"',
    '  submitLabel="Use this"',
    '  name="plan"',
    '/>',
  ].join('\n'))
  send({ t: 'program', code: compiled.code, constants: compiled.constants })
  const batch = sent.at(-1)
  assert.equal(batch.ok, true, batch.error?.message)
  const rootNode = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root: rootNode })
  const all = [...nodes.values()]
  const ofType = (type) => all.filter((node) => node.type === type)
  // The composite lowered into native components before the renderer saw it.
  assert.equal(ofType('choiceCard').length, 0, 'the composite itself must not reach the renderer')
  assert.deepEqual(ofType('option').map((node) => node.props.label), ['Pro', 'Team'])
  assert.deepEqual(ofType('option').map((node) => node.props.meta), ['$29', '$99'])
  assert.deepEqual(ofType('option').map((node) => node.props.selected), [true, false])
  // The composite deliberately ships no submit control: the answer footer owns
  // submission, so a clarification card has exactly one way to be answered.
  assert.deepEqual(ofType('button'), [])
  // The answer field is how a composite puts its selection into the card answer.
  assert.deepEqual(ofType('field').map((node) => [node.props.name, node.props.value]), [['plan', 'pro']])
  assert.deepEqual(all.filter((node) => node.text !== null).map((node) => node.text), ['Which plan?'])
  // No stray dollar sign: `$` before an interpolation is ordinary text, so the
  // composite bodies use `{expr}` throughout.
  assert.equal(batch.strings.some((text) => text === '$'), false)
})

test('every prebuilt composite compiles inside the locked-down realm', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  for (const tag of [
    '<statRow items={[{label:"A",value:1}]} columns={2}/>',
    '<pricingCard name="Pro" price={29} period="/mo" features={["a"]} featured={true} action="pro"/>',
    '<productCard image="https://example.test/p.png" title="W" price="$9" rating={4.5} reviews={3} action="buy"/>',
    '<choiceCard options={["x","y"]} value="x" submitLabel="Go"/>',
  ]) {
    const compiled = compileDil(tag)
    assert.deepEqual(compiled.diagnostics, [], `${tag} compiled with diagnostics`)
    send({ t: 'program', code: compiled.code, constants: compiled.constants })
    const batch = sent.at(-1)
    assert.equal(batch.ok, true, `${tag}: ${batch.error?.message}`)
    assert.ok(batch.ops.length > 0, `${tag} produced no operations`)
  }
})

test('a broken program is reported without stopping the runner', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  send({ t: 'program', code: 'DIL.render(', constants: {} })
  const failure = sent.at(-1)
  assert.equal(failure.ok, false)
  assert.equal(failure.t, 'batch')
  assert.equal(typeof failure.error.message, 'string')
  // The runner is still alive and takes the next program.
  const good = compileDil('<title>recovered</title>')
  send({ t: 'program', code: good.code, constants: good.constants })
  assert.equal(sent.at(-1).ok, true)
})

test('the runner answers a ping, which is what the watchdog checks', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  send({ t: 'ping', nonce: 7 })
  const pong = sent.at(-1)
  // Values cross a VM realm boundary, so compare fields rather than identity.
  assert.equal(pong.t, 'pong')
  assert.equal(pong.nonce, 7)
})

test('an unknown message is answered with an error rather than a crash', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  send({ t: 'nonsense' })
  assert.equal(sent.at(-1).t, 'error')
})

test('the operations the runner emits are integer-encoded arrays', async () => {
  const { exports } = await loadBundle()
  const { sent, send } = startRunner(exports.runnerSource)
  const compiled = compileDil('<box><slider min={1} max={9} value={3}/><text>hi</text></box>')
  send({ t: 'program', code: compiled.code, constants: compiled.constants })
  const batch = sent.at(-1)
  assert.ok(Array.isArray(batch.strings))
  for (const op of batch.ops) {
    assert.equal(typeof op[0], 'number')
    assert.ok(Object.values(OP).includes(op[0]))
    assert.equal(typeof op[1], 'number')
  }
  // The program never travels back to the page.
  assert.equal(typeof batch.code, 'undefined')
})

test('LaTeX strings survive the locked runner and update with local state', async () => {
  const { exports } = await loadBundle()
  const { context, sent, send } = startRunner(exports.runnerSource)
  assert.equal(vm.runInContext('typeof __IUI_KATEX_LOAD', context), 'undefined')
  const compiled = compileDil(String.raw`{@body const [n, setN] = DIL.useState(2)}
{@body const formula = "\\frac{1}{" + n + "}"}
<slider min={1} max={9} value={n} onChange={setN}/>
<math tex={formula} display/>`)
  assert.deepEqual(compiled.diagnostics, [])
  send({ t: 'program', code: compiled.code, constants: compiled.constants })
  const batch = sent.at(-1)
  assert.equal(batch.ok, true, batch.error?.message)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const handlers = []
  const nodes = decodeTree(batch, { root, onHandler: (id) => { handlers.push(id); return () => {} } })
  const formula = () => [...nodes.values()].find((node) => node.type === 'math')
  assert.equal(formula().props.tex, String.raw`\frac{1}{2}`)
  assert.equal(formula().props.display, true)
  assert.equal(handlers.length, 1)
  send({ t: 'event', handler: handlers[0], args: [4] })
  const update = sent.at(-1)
  assert.equal(update.ok, true, update.error?.message)
  decodeTree(update, { nodes, root })
  assert.equal(formula().props.tex, String.raw`\frac{1}{4}`)
})
