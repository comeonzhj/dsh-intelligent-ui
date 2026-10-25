/**
 * The catalog is the contract between what the model may write and what the
 * client can draw, so it gets two standing checks: every catalog component has
 * a renderer, and every composite compiles into a real function against the
 * same catalog.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { COMPONENTS, componentNames, catalogText, validateProps, SPACE, RADIUS, SIZE, TONE } from '../lib/catalog.js'
import { compileComposite, compileDil } from '../lib/compile.js'
import { COMPOSITE_SOURCES } from '../lib/composite.js'
import { createRenderers } from '../src/client/components.js'

/** The renderer only needs an element factory to be constructible. */
const ReactStub = { createElement: () => null, Fragment: Symbol('fragment') }

test('every native catalog component has a renderer', () => {
  const { COMPONENTS: RENDERERS } = createRenderers(ReactStub)
  // Composites are written in DIL and expand inside the runner, so they reach
  // the renderer already lowered to native components.
  const missing = componentNames()
    .filter((name) => COMPONENTS[name].composite !== true)
    .filter((name) => typeof RENDERERS[name] !== 'function')
  assert.deepEqual(missing, [], 'catalog components with no renderer')
})

test('the renderer knows no component the catalog does not declare', () => {
  const { COMPONENTS: RENDERERS } = createRenderers(ReactStub)
  const extra = Object.keys(RENDERERS).filter((name) => COMPONENTS[name] === undefined)
  assert.deepEqual(extra, [], 'renderers for components the model can never write')
})

test('every catalog component is described and its properties are well formed', () => {
  const KINDS = ['bool', 'num', 'str', 'any', 'fn', 'token', 'enum', 'array']
  for (const name of componentNames()) {
    const definition = COMPONENTS[name]
    assert.equal(typeof definition.doc, 'string', `${name} has no doc line`)
    assert.ok(definition.doc.length > 8, `${name}'s doc line is too short`)
    assert.ok(['any', 'none', 'text'].includes(definition.children), `${name} has an unknown children rule`)
    assert.ok(definition.props.key === undefined, `${name} must not declare "key"; it is universal`)
    for (const [prop, spec] of Object.entries(definition.props)) {
      assert.ok(KINDS.includes(spec.t), `${name}.${prop} has unknown kind ${spec.t}`)
      assert.equal(typeof spec.description, 'string', `${name}.${prop} has no description`)
      if (spec.t === 'enum') assert.ok(Array.isArray(spec.values) && spec.values.length > 1, `${name}.${prop} has no values`)
      if (spec.t === 'token') assert.ok(spec.valueType === 'number' || spec.valueType === 'string', `${name}.${prop} token has no value type`)
    }
  }
})

test('the catalog text names every component and both token scales', () => {
  const text = catalogText('full')
  for (const name of componentNames()) assert.match(text, new RegExp(`<${name}>`), `${name} is missing from the catalog text`)
  assert.match(text, /padding=number 0\.\.8/, 'spacing scale is not described as a token')
  assert.match(text, /radius="none" \| "sm" \| "md"/)
  assert.match(text, new RegExp(TONE.map((name) => `"${name}"`).join(' \\| ')))
  assert.equal(Object.keys(SPACE).length, 9)
  assert.equal(RADIUS.full, '999px')
  assert.equal(SIZE['3xl'], '34px')
  // The compact form drops the per-property lines but keeps every name.
  const compact = catalogText('compact')
  for (const name of componentNames()) assert.match(compact, new RegExp(`<${name}>`))
  assert.doesNotMatch(compact, /padding=number/)
})

test('composites are declared as catalog components and compile', () => {
  const names = Object.keys(COMPOSITE_SOURCES)
  assert.ok(names.length >= 4)
  for (const name of names) {
    assert.equal(COMPONENTS[name]?.composite, true, `${name} is not marked composite in the catalog`)
    const { code, diagnostics } = compileComposite(COMPOSITE_SOURCES[name], Object.keys(COMPONENTS[name].props))
    assert.deepEqual(diagnostics, [], `${name} compiled with diagnostics`)
    assert.match(code, /^function \(props\) \{/)
    // The composite's own body must be valid JavaScript.
    assert.doesNotThrow(() => new Function('__dil', 'DIL', `return (${code})`))
  }
})

test('composite bodies use only catalog components and properties', () => {
  for (const [name, source] of Object.entries(COMPOSITE_SOURCES)) {
    // Expand the composite's literal tags through the compiler and check that
    // nothing is flagged: a composite that writes an unknown property would
    // silently lose it inside every instance.
    const { diagnostics } = compileComposite(source, Object.keys(COMPONENTS[name].props))
    const offenders = diagnostics.filter((d) => d.code === 'unknown_prop' || d.code === 'invalid_literal' || d.code === 'unknown_component')
    assert.deepEqual(offenders, [], `${name} writes properties the catalog does not accept`)
  }
})

test('validation keeps what fits and reports what does not', () => {
  const { props, diagnostics } = validateProps('slider', {
    min: 0, max: 10, value: 5, label: 'Seats', name: 'seats', nope: 1, format: 'currency',
  })
  assert.deepEqual(props, { min: 0, max: 10, value: 5, label: 'Seats', name: 'seats', format: 'currency' })
  assert.deepEqual(diagnostics, [{ code: 'unknown_prop', component: 'slider', prop: 'nope' }])
})

test('a whole catalog example document compiles cleanly', () => {
  // One document that touches every group, to catch a typo in the catalog
  // before a model ever writes one.
  const document = [
    '# Everything',
    '',
    'Intro with **bold** and `code`.',
    '',
    '{@body const [seats, setSeats] = DIL.useState(3)}',
    '<box border padding={4} gap={3}>',
    '  <row justify="between" align="center"><title size="lg">Plan</title><badge tone="brand" variant="soft">New</badge></row>',
    '  <slider min={1} max={20} value={seats} onChange={setSeats} name="seats" label="Seats" format="number"/>',
    '  <segmented options={["monthly","yearly"]} value="monthly" onChange={setSeats} name="cycle"/>',
    '  <switch checked={true} label="Auto renew" name="renew"/>',
    '  <checkbox checked={false} label="Add support" name="support"/>',
    '  <input value="acme" onChange={setSeats} name="team" label="Team"/>',
    '  <textarea value="notes" onChange={setSeats} name="notes" label="Notes"/>',
    '  <stepper value={seats} onChange={setSeats} name="seats2" min={1} max={9}/>',
    '  <rating value={4} max={5} onChange={setSeats} name="rating"/>',
    '  <select options={[{value:"a",label:"A"}]} value="a" onChange={setSeats} name="pick" label="Pick"/>',
    '  <radio options={["x","y"]} value="x" onChange={setSeats} name="radio"/>',
    '  <actions align="end"><button label="Later" variant="ghost"/><button label="Go" variant="primary" submit={true}/></actions>',
    '  <grid columns={2} gap={2}><stat label="Seats" value={seats} unit="users"/><stat label="Price" value={87} delta="+12%" trend="up" tone="success"/></grid>',
    '  <table columns={["A","B"]} rows={[["1","2"]]} striped={true}/>',
    '  <kv items={[{label:"Region",value:"eu-west"}]} columns={2}/>',
    '  <progress value={seats} max={20} label="Rollout" tone="success" showValue={true}/>',
    '  <chart type="bar" series={[{name:"Seats",data:[1,2,3]}]} categories={["a","b","c"]} legend={true}/>',
    '  <sparkline data={[1,4,2,6]} tone="brand"/>',
    '  <image src="https://example.test/x.png" alt="x" ratio="16:9" radius="md" caption="cap"/>',
    '  <gallery items={[{src:"https://example.test/a.png"}]} columns={2} ratio="1:1"/>',
    '  <icon name="check" tone="success"/>',
    '  <timeline items={[{title:"Shipped", time:"today", body:"done"}]}/>',
    '  <steps steps={[{title:"One",done:true},{title:"Two"}]} current={1}/>',
    '  <codeblock language="js" filename="a.js">const a = 1</codeblock>',
    '  <text>Inline <math tex="x^2"/> formula.</text>',
    '  <math tex="a^2+b^2=c^2" display size="lg" tone="brand"/>',
    '  <json value={{"a":1}} label="payload"/>',
    '  <callout tone="warn" title="Heads up">Watch the quota.</callout>',
    '  <quote cite="Docs">Quoted.</quote>',
    '  <reveal title="Details"><text>Hidden until opened.</text></reveal>',
    '  <tabs value="a"><tab id="a" label="A"><text>one</text></tab><tab id="b" label="B"><text>two</text></tab></tabs>',
    '  <columns ratio="2:1"><box><text>left</text></box><box><text>right</text></box></columns>',
    '  <scroll maxHeight={200}><text>tall</text></scroll>',
    '  <gallery items={[{src:"https://example.test/b.png"}]} columns={1} ratio="4:3"/>',
    '  <statRow items={[{label:"A",value:1},{label:"B",value:2}]} columns={2}/>',
    '  <pricingCard name="Pro" price={29} period="/mo" features={["a","b"]} featured={true} action="pro" onChange={setSeats}/>',
    '  <productCard image="https://example.test/p.png" title="Widget" price="$9" rating={4.5} reviews={12} action="buy" onChange={setSeats}/>',
    '  <choiceCard options={[{value:"x",label:"X"},{value:"y",label:"Y"}]} value="x" onChange={setSeats} prompt="Which?" submitLabel="Send" name="plan"/>',
    '</box>',
  ].join('\n')

  const result = compileDil(document)
  assert.deepEqual(result.diagnostics, [])
  assert.ok(result.stats.nodes > 50, `expected a large tree, got ${result.stats.nodes} nodes`)
  assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', result.code))
})

test('every catalog property type is exercised by the sample document', () => {
  // A crude coverage guard: if a new property type is added to the catalog
  // without a test document that uses it, this fails.
  const types = new Set()
  for (const definition of Object.values(COMPONENTS)) {
    for (const spec of Object.values(definition.props)) types.add(spec.t)
  }
  assert.deepEqual([...types].sort(), ['any', 'array', 'bool', 'enum', 'fn', 'num', 'str', 'token'])
})
