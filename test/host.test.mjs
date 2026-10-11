/**
 * The Host half, against a minimal stand-in for the harness registries.
 *
 * The point is not to re-implement DSH: it is to pin the shape the Host
 * publishes — the two tools' parameters and output schema, the durable
 * compilation record, and the prompt section — because that shape is what the
 * browser half and the model both depend on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name, compileCall } from '../index.js'
import { ASK_TOOL, DELIVER_TOOL, TOOL_NAMES, promptSectionText, toolDescription } from '../lib/prompt.js'
import { COMPONENTS } from '../lib/catalog.js'

/** A Context that records what the plugin registers. */
function fakeContext() {
  const registered = { tools: [], sections: [], effects: 0, effectLabels: [], disposers: [], disposed: [] }
  const ctx = {
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => registered.disposed.push(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        registered.sections.push(section)
        return () => registered.disposed.push(section.name)
      },
    },
    effect(run, label) {
      registered.effects += 1
      registered.effectLabels.push(label)
      const disposer = run()
      if (typeof disposer === 'function') registered.disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, registered }
}

/** Register the plugin and hand back the tools by name. */
function toolsOf(config = {}) {
  const { ctx, registered } = fakeContext()
  apply(ctx, config)
  return { registered, byName: (toolName) => registered.tools.find((tool) => tool.name === toolName) }
}

test('the plugin declares the services it needs and its own name', () => {
  assert.equal(name, 'intelligent-ui')
  assert.deepEqual(inject, ['tools', 'systemPrompt'])
  assert.deepEqual([...TOOL_NAMES], [DELIVER_TOOL, ASK_TOOL])
})

test('the Host registers exactly two tools, with usable schemas', () => {
  const { registered } = toolsOf()
  assert.deepEqual(registered.tools.map((tool) => tool.name), [DELIVER_TOOL, ASK_TOOL])
  for (const tool of registered.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.properties.dil.type, 'string')
    // `dil` is declared first so the browser receives it first in the stream.
    assert.equal(Object.keys(tool.parameters.properties)[0], 'dil')
    assert.equal(tool.parameters.additionalProperties, false)
    // The output schema is the wire JSON-Schema subset: `required` is an array.
    assert.equal(tool.output.schema.type, 'object')
    assert.ok(Array.isArray(tool.output.schema.required))
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.output.presentationMeta, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('only the clarification tool offers an answer contract', () => {
  const { byName } = toolsOf()
  const deliver = byName(DELIVER_TOOL)
  const clarify = byName(ASK_TOOL)

  // The delivery tool cannot be asked for a feedback form, because a feedback
  // form is not part of what it accepts — the conversation's own composer is
  // where feedback belongs.
  assert.deepEqual(deliver.parameters.required, ['dil'])
  assert.equal('ask' in deliver.parameters.properties, false)
  assert.deepEqual(Object.keys(deliver.parameters.properties), ['dil', 'title', 'surface'])

  assert.deepEqual(clarify.parameters.required, ['dil', 'ask'])
  assert.equal(clarify.parameters.properties.ask.type, 'object')
  assert.deepEqual(
    Object.keys(clarify.parameters.properties.ask.properties),
    ['prompt', 'submitLabel', 'notePlaceholder', 'allowNote'],
  )
  // The two descriptions say different things, which is the point of two tools.
  assert.notEqual(deliver.description, clarify.description)
  assert.match(deliver.description, /反馈入口|feedback entry point/)
  assert.match(clarify.description, /ask_with_ui|render_ui/)
})

test('both tools describe themselves, in both languages', () => {
  for (const language of ['zh', 'en']) {
    const deliver = toolDescription('deliver', language)
    const clarify = toolDescription('clarify', language)
    assert.ok(deliver.length > 40 && clarify.length > 40)
    assert.notEqual(deliver, clarify)
  }
  assert.match(toolDescription('deliver', 'en'), /feedback/)
  assert.match(toolDescription('clarify', 'en'), /Stop after calling it/)
})

test('a delivered call compiles into a program plus a constants table', async () => {
  const { byName } = toolsOf()
  const tool = byName(DELIVER_TOOL)
  const args = {
    dil: '## Team plan estimate\nDrag the slider.\n{@body const [seats,setSeats] = DIL.useState(8)}\n<slider min={1} max={50} value={seats} onChange={setSeats}/>',
    title: 'Team plan',
    surface: 'team-plan',
  }

  const value = await tool.execute(args)
  assert.equal(value.ok, true)
  assert.equal(value.kind, 'deliver')
  assert.equal(value.title, 'Team plan')
  assert.ok(value.nodes > 0)
  assert.deepEqual(value.diagnostics, [])
  assert.match(value.receipt, /Team plan/)

  // The model reads a receipt, never the program.
  const blocks = tool.output.render(args, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.doesNotMatch(blocks[0].text, /__dil\.jsx/)

  // The browser re-renders from the durable record.
  const meta = tool.output.presentationMeta(args, value)
  assert.equal(meta.v, 3)
  assert.equal(meta.kind, 'deliver')
  assert.equal(meta.surface, 'team-plan')
  assert.equal(meta.title, 'Team plan')
  assert.match(meta.code, /DIL\.render\(__dil\.jsx/)
  assert.deepEqual(meta.constants, { 0: 'Team plan estimate', 1: 'Drag the slider.' })
  assert.equal(meta.dil, args.dil)
  // A delivery carries no answer contract at all.
  assert.equal('ask' in meta, false)
  // Everything in it survives a JSON round trip, which is what persistence does.
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
})

test('the clarification tool keeps the answer contract', async () => {
  const { byName } = toolsOf()
  const tool = byName(ASK_TOOL)
  const args = {
    dil: '<choiceCard options={["a","b"]} value="a" name="pick"/>',
    title: 'Which one?',
    ask: { prompt: 'Pick one to continue', submitLabel: 'Use this' },
  }
  const value = await tool.execute(args)
  assert.equal(value.kind, 'clarify')
  assert.match(value.receipt, /停下等人回答|wait/)
  const meta = tool.output.presentationMeta(args, value)
  assert.equal(meta.kind, 'clarify')
  assert.deepEqual(meta.ask, { prompt: 'Pick one to continue', submitLabel: 'Use this', allowNote: true })
  assert.equal('notePlaceholder' in meta.ask, false, 'an undefined field must not be persisted')
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
})

test('the delivery tool refuses an answer contract and says so', async () => {
  const { byName } = toolsOf()
  const tool = byName(DELIVER_TOOL)
  // The model ignored the schema and sent one anyway.
  const args = { dil: '<title>Done</title>', ask: { prompt: 'Happy?', submitLabel: 'Send' } }
  const value = await tool.execute(args)
  assert.ok(value.diagnostics.some((d) => d.code === 'ask_not_allowed'))
  assert.match(value.receipt, /反馈入口|feedback/)
  const meta = tool.output.presentationMeta(args, value)
  assert.equal('ask' in meta, false, 'no feedback form may reach a deliverable')
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta)
})

test('every compilation record is lossless JSON', () => {
  // A non-lossless `presentationMeta` fails the whole tool call, not just the
  // card, so this is a hard requirement rather than a nicety.
  const cases = [
    { dil: 'plain' },
    { dil: '<box/>', title: 'T' },
    { dil: '<box/>', ask: {} },
    { dil: '<box/>', ask: { prompt: 'p', submitLabel: 's', notePlaceholder: 'n', allowNote: false } },
    { dil: '<box sparkle="x"/>', surface: 's' },
    { dil: '<chart type="bar" series={[{name:"a",data:[1,2]}]} legend={true}/>' },
  ]
  for (const kind of ['deliver', 'clarify']) {
    for (const args of cases) {
      const { value, meta } = compileCall(args, { language: 'zh' }, kind)
      assert.deepEqual(JSON.parse(JSON.stringify(meta)), meta, `not lossless for ${kind} ${JSON.stringify(args)}`)
      assert.equal(meta.kind, kind)
      assert.equal(value.kind, kind)
    }
  }
})

test('a title is derived when the model omits one', () => {
  const derived = compileCall({ dil: '## Quarterly outlook\n\nSome prose.' }, { language: 'en' })
  assert.equal(derived.value.title, 'Quarterly outlook')
  const prose = compileCall({ dil: 'Just a sentence.' }, { language: 'en' })
  assert.equal(prose.value.title, 'Just a sentence.')
})

test('bad arguments are reported, never thrown', () => {
  const empty = compileCall({}, { language: 'en' })
  assert.equal(empty.value.ok, true)
  assert.equal(empty.value.title, 'Interactive card')
  const wrongType = compileCall({ dil: 42, title: 7 }, { language: 'en' })
  assert.equal(wrongType.value.ok, true)
  assert.equal(wrongType.value.nodes, 0)
})

test('the receipt names what the compiler adjusted', () => {
  const { value } = compileCall({ dil: '<box sparkle="yes" gap="1"/>' }, { language: 'en' })
  assert.equal(value.diagnostics.length, 2)
  assert.match(value.receipt, /adjusted 2 thing/)
  assert.match(value.receipt, /sparkle/)
  assert.match(value.receipt, /gap/)
  const zh = compileCall({ dil: '<box sparkle="yes"/>' }, { language: 'zh' }).value.receipt
  assert.match(zh, /调整了 1 处/)
})

test('the prompt section teaches DIL and carries the catalog', () => {
  const { registered } = toolsOf({ detail: 'compact' })
  assert.equal(registered.sections.length, 1)
  const section = registered.sections[0]
  assert.equal(section.name, 'intelligent-ui')
  assert.equal(typeof section.order, 'number')
  const text = section.text()
  assert.match(text, /## Intelligent UI/)
  assert.match(text, /\{@body/)
  assert.match(text, /DIL\.useState/)
  assert.match(text, /DIL\.h/)
  for (const tool of TOOL_NAMES) assert.match(text, new RegExp('`' + tool + '`'))
  // The rule that keeps a feedback form out of a deliverable is stated, not
  // merely enforced by the schema.
  assert.match(text, /不要在交付物里放反馈入口/)
  // And the submit control has exactly one home, so a model does not add a
  // second entry point inside the card.
  assert.match(text, /不要在卡片里自己写提交按钮/)
  // Compact detail still lists every component name.
  for (const component of Object.keys(COMPONENTS)) {
    assert.match(text, new RegExp(`<${component}>`), `${component} is missing from the prompt`)
  }
})

test('the protocol section can be turned off, and English is available', () => {
  const off = toolsOf({ prompt: false })
  assert.equal(off.registered.sections.length, 0)
  assert.equal(off.registered.tools.length, 2)

  const en = toolsOf({ language: 'en' })
  assert.match(en.registered.tools[0].description, /Render a structured or interactive answer/)
  assert.match(en.registered.sections[0].text(), /Intelligent UI: text plus a rich card/)
  assert.match(en.registered.sections[0].text(), /Never put a feedback entry point in a deliverable/)
})

test('every registration is an effect, so unloading removes it', () => {
  const { registered } = toolsOf()
  // One tools effect and one prompt effect, each labelled for diagnostics.
  assert.equal(registered.effects, 2)
  assert.deepEqual(registered.effectLabels, ['intelligent-ui: render_ui + ask_with_ui', 'intelligent-ui: DIL protocol'])
  assert.equal(registered.disposers.length, 2)
  assert.deepEqual(registered.disposed, [])
  // Unloading the plugin, as an HMR drain or a disable would.
  for (const dispose of registered.disposers) dispose()
  assert.deepEqual(registered.disposed, ['render_ui', 'ask_with_ui', 'intelligent-ui'])
})

test('the prompt text is stable in shape across detail levels', () => {
  const full = promptSectionText({ detail: 'full', language: 'zh' })
  const compact = promptSectionText({ detail: 'compact', language: 'zh' })
  assert.ok(full.length > compact.length)
  assert.ok(full.includes('### Catalog') && compact.includes('### Catalog'))
})
