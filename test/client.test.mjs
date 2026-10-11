/**
 * The two pieces of page-side logic that are easy to get subtly wrong.
 *
 * `extractArgs` reads a JSON prefix that stops wherever the model happened to
 * be — the tool arguments stream, so at most moments the value is not valid
 * JSON at all. `collectAnswers` decides what the card actually sends back.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractArgs, collectAnswers, answerMessage, rawArgumentsText, resolveCardCall, hasSubmitControl,
  TOOL_NAME, ASK_TOOL_NAME, CARD_TOOLS, PLUGIN_NAME, NS,
} from '../src/client/app.js'
import { compileDil } from '../lib/compile.js'
import { createDilRuntime, decodeTree, ROOT_ID } from '../src/runtime/runtime.js'
import { buildComposites } from '../lib/composite.js'

/** The exact bytes the tool-argument stream produces, in order. */
function streamOf(value) {
  const full = JSON.stringify(value)
  const out = []
  for (let i = 1; i <= full.length; i += 1) out.push(full.slice(0, i))
  return out
}

test('the tool names and namespace are the ones the Host registers', () => {
  assert.equal(TOOL_NAME, 'render_ui')
  assert.equal(ASK_TOOL_NAME, 'ask_with_ui')
  assert.deepEqual([...CARD_TOOLS], ['render_ui', 'ask_with_ui'])
  assert.equal(PLUGIN_NAME, '@comeonzhj/dsh-intelligent-ui')
  assert.equal(NS, 'intelligent-ui')
})

test('every prefix of the arguments yields a usable, growing value', () => {
  const args = {
    dil: '## Plan\n{@body const [n, setN] = DIL.useState(1)}\n<slider value={n} onChange={setN} name="n"/>',
    title: 'Plan',
    surface: 'plan',
    ask: { prompt: 'How many?', submitLabel: 'Send' },
  }
  let previousLength = 0
  for (const prefix of streamOf(args)) {
    const parsed = extractArgs(prefix)
    assert.equal(typeof parsed.dil, 'string', `no dil at prefix ${prefix.length}`)
    // The DIL only ever grows: that is what makes the card stream.
    assert.ok(parsed.dil.length >= previousLength, `dil shrank at prefix ${prefix.length}`)
    previousLength = parsed.dil.length
    // Whatever came out must compile, because that is what the card does with it.
    assert.doesNotThrow(() => compileDil(parsed.dil))
  }
  const complete = extractArgs(JSON.stringify(args))
  assert.equal(complete.dil, args.dil)
  assert.equal(complete.title, 'Plan')
  assert.equal(complete.surface, 'plan')
  assert.equal(complete.prompt, 'How many?')
  assert.equal(complete.submitLabel, 'Send')
})

test('an empty prefix is not an error', () => {
  for (const text of ['', '{', '{"', '{"dil"', '{"dil"', '{"dil":', '{"dil":"']) {
    const parsed = extractArgs(text)
    assert.equal(typeof parsed.dil, 'string')
    assert.equal(parsed.dil, '')
  }
  assert.equal(extractArgs(undefined).dil, '')
  assert.equal(extractArgs(null).dil, '')
})

test('escapes survive the prefix walk', () => {
  const args = { dil: '<text>line one\nline two\ttabbed "quoted" \\ back</text>', title: 'A "quoted" title' }
  const full = JSON.stringify(args)
  assert.equal(extractArgs(full).dil, args.dil)
  assert.equal(extractArgs(full).title, args.title)
  // Stopping mid-escape must not produce a crash or a wrong character.
  const midEscape = full.slice(0, full.indexOf('\\n') + 1)
  assert.equal(typeof extractArgs(midEscape).dil, 'string')
  // A unicode escape is decoded too.
  assert.equal(extractArgs('{"dil":"\\u4e2d\\u6587"}').dil, '中文')
  // A trailing backslash at the cut is tolerated.
  assert.equal(typeof extractArgs('{"dil":"abc\\').dil, 'string')
  assert.equal(extractArgs('{"dil":"abc\\').dil, 'abc')
})

test('a boolean field is read only once it is complete', () => {
  assert.equal(extractArgs('{"ask":{"allowNote":').allowNote, null)
  assert.equal(extractArgs('{"ask":{"allowNote":tr').allowNote, null)
  assert.equal(extractArgs('{"ask":{"allowNote":true').allowNote, true)
  assert.equal(extractArgs('{"ask":{"allowNote":false').allowNote, false)
})

test('a very large prefix is refused rather than parsed', () => {
  const huge = `{"dil":"${'x'.repeat(100 * 1024)}"}`
  const parsed = extractArgs(huge)
  assert.equal(parsed.truncated, true)
  assert.equal(typeof parsed.dil, 'string')
})

test('the argument text is found in all three call phases', () => {
  const args = { dil: '<box/>', title: 'T' }
  const raw = JSON.stringify(args)
  // `preparing`: nothing is dispatched, so the Tool layer's prefix is the source.
  assert.equal(rawArgumentsText('preparing', { phase: 'preparing', callId: 'c' }, raw.slice(0, 10)), raw.slice(0, 10))
  assert.equal(rawArgumentsText('preparing', { phase: 'preparing' }, ''), '')
  // `start`: the complete arguments sit on the call itself.
  assert.equal(rawArgumentsText('start', { phase: 'start', argsRaw: raw }, ''), raw)
  // `result`: a ToolResultNode nests the call head under `call`.
  assert.equal(rawArgumentsText('result', { kind: 'tool-result', call: { name: 'render_ui', argsRaw: raw } }, ''), raw)
  // `result` with the call head outside the window: nothing to render from.
  assert.equal(rawArgumentsText('result', { kind: 'tool-result', call: null }, ''), '')
  assert.equal(rawArgumentsText('result', undefined, undefined), '')
  // A phase that somehow carries both prefers the dispatched arguments.
  assert.equal(rawArgumentsText('start', { argsRaw: raw }, 'stale'), raw)
})

test('the turn tail finds the last card call of its turn', () => {
  const delivered = JSON.stringify({ dil: '<box/>', title: 'Delivered' })
  const asked = JSON.stringify({ dil: '<box/>', ask: { prompt: 'Which?' } })
  // A dispatched call, then a settled one: the settled (latest) wins.
  assert.deepEqual(resolveCardCall([
    { root: { phase: 'start', name: 'render_ui', argsRaw: JSON.stringify({ dil: '<box/>', title: 'First' }) } },
    { root: { kind: 'tool-result', call: { name: 'render_ui', argsRaw: delivered } } },
  ]), { tool: 'render_ui', raw: delivered })
  // Both tools are the plugin's; the latest of either wins, and the tool name
  // travels with it so the card knows whether it is answering a question.
  assert.deepEqual(resolveCardCall([
    { root: { kind: 'tool-result', call: { name: 'render_ui', argsRaw: delivered } } },
    { root: { kind: 'tool-result', call: { name: 'ask_with_ui', argsRaw: asked } } },
  ]), { tool: 'ask_with_ui', raw: asked })
  // Only our tools count.
  assert.equal(resolveCardCall([{ root: { name: 'bash', argsRaw: delivered } }]), null)
  assert.equal(resolveCardCall([{ root: { kind: 'tool-result', call: { name: 'bash', argsRaw: delivered } } }]), null)
  // A result whose call head fell outside the log window renders nothing.
  assert.equal(resolveCardCall([{ root: { kind: 'tool-result', call: null } }]), null)
  // Empty / malformed input is not an error.
  assert.equal(resolveCardCall([]), null)
  assert.equal(resolveCardCall(undefined), null)
  assert.equal(resolveCardCall([{}, { root: null }, { root: { name: 'render_ui', argsRaw: '' } }]), null)
})

/* ------------------------------------------------------------------ *
 * Answers
 * ------------------------------------------------------------------ */

/** Render a document and decode its operations into a page-side node tree. */
function treeOf(dil) {
  const compiled = compileDil(dil)
  // With the composite catalog, so `<choiceCard>` lowers the same way it does
  // in the sandbox.
  const runtime = createDilRuntime({ catalog: (api) => buildComposites(api) })
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  assert.equal(batch.ok, true, batch.error?.message)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root, onHandler: () => () => {} })
  return { root, nodes, runtime, batch }
}

test('answers collect every named control', () => {
  const { root } = treeOf([
    '<box>',
    '  <slider min={1} max={9} value={seats} name="seats" onChange={setSeats}/>',
    '  <switch checked={renew} name="renew" onChange={setRenew}/>',
    '  <input value={team} name="team" onChange={setTeam}/>',
    '  <segmented options={["a","b"]} value={cycle} name="cycle" onChange={setCycle}/>',
    '  <rating value={score} name="score" max={5} onChange={setScore}/>',
    '  <stepper value={count} name="count" onChange={setCount}/>',
    '  <text>An unnamed control</text>',
    '  <slider min={0} max={9} value={7}/>',
    '</box>',
    '{@body const [seats, setSeats] = DIL.useState(4)}',
    '{@body const [renew, setRenew] = DIL.useState(true)}',
    '{@body const [team, setTeam] = DIL.useState("acme")}',
    '{@body const [cycle, setCycle] = DIL.useState("b")}',
    '{@body const [score, setScore] = DIL.useState(3)}',
    '{@body const [count, setCount] = DIL.useState(2)}',
  ].join('\n'))

  const answers = collectAnswers(root)
  assert.equal(answers.empty, false)
  assert.deepEqual(answers.order, ['seats', 'renew', 'team', 'cycle', 'score', 'count'])
  assert.deepEqual(answers.values, { seats: 4, renew: true, team: 'acme', cycle: 'b', score: 3, count: 2 })
})

test('a card with no named control has an empty answer', () => {
  const { root } = treeOf('<box><title>Nothing to answer</title><slider min={0} max={9} value={1}/></box>')
  const answers = collectAnswers(root)
  assert.equal(answers.empty, true)
  assert.deepEqual(answers.values, {})
})

test('an invisible field carries a composite selection into the answer', () => {
  const { root } = treeOf([
    '<choiceCard options={[{value:"pro",label:"Pro"},{value:"team",label:"Team"}]} value="team" prompt="Pick" submitLabel="Go" name="plan"/>',
  ].join('\n'))
  const answers = collectAnswers(root)
  assert.deepEqual(answers.order, ['plan'])
  assert.deepEqual(answers.values, { plan: 'team' })
})

test('the answer reads as an ordinary message the model can act on', () => {
  const text = answerMessage({
    callId: 'call-1',
    surface: 'plan',
    title: 'Team plan',
    order: ['seats', 'plan'],
    values: { seats: 12, plan: 'pro' },
    note: 'starting in April',
  })
  assert.match(text, /^\[Intelligent UI\] Team plan/)
  assert.match(text, /call call-1/)
  assert.match(text, /- seats: 12/)
  assert.match(text, /- plan: pro/)
  assert.match(text, /- note: starting in April/)
  // It is plain text: no markup, no JSON blob for the model to decode.
  assert.doesNotMatch(text, /[{}]/)
})

test('an answer with no values still says so', () => {
  const text = answerMessage({ title: 'Card', order: [], values: {} })
  assert.match(text, /no named values/)
  assert.doesNotMatch(text, /note:/)
})

test('object values are serialized rather than stringified to [object Object]', () => {
  const text = answerMessage({ title: 'T', order: ['range'], values: { range: { from: 1, to: 9 } } })
  assert.match(text, /- range: \{"from":1,"to":9\}/)
})

test('a card never gets two ways to answer', () => {
  // A model-authored submit control wins; the footer keeps the question and the
  // note but drops its own button.
  const withButton = treeOf('<box><button label="Go" submit={true}/><slider min={0} max={9} value={1} name="n"/></box>')
  assert.equal(hasSubmitControl(withButton.root), true)
  const withoutButton = treeOf('<box><slider min={0} max={9} value={1} name="n"/></box>')
  assert.equal(hasSubmitControl(withoutButton.root), false)
  // A form's generated submit button counts too.
  assert.equal(hasSubmitControl(treeOf('<form submitLabel="Send"><input value="a" name="x"/></form>').root), true)
  // A plain button that does not submit does not count.
  assert.equal(hasSubmitControl(treeOf('<actions><button label="Later" variant="ghost"/></actions>').root), false)
  // An empty tree is not an error.
  assert.equal(hasSubmitControl(null), false)
  assert.equal(hasSubmitControl({}), false)

  // The composite no longer ships its own submit control: the answer footer is
  // the single place a card is submitted from.
  const choice = treeOf('<choiceCard options={["a","b"]} value="a" name="pick"/>')
  assert.equal(hasSubmitControl(choice.root), false)
})
