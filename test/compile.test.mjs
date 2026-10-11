/**
 * The compiler, held to the article's own capture.
 *
 * The reference document walks one small response — a heading, a paragraph, two
 * JavaScript statement lines and a slider bound to state — through every layer,
 * and prints both the compiled program and the constants document. Those two
 * artifacts are the specification for this file.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { compileDil, compileComposite, lowerDocument, parseLiteral, fallbackMarkdown } from '../lib/compile.js'

/** The article's example, verbatim. */
const ARTICLE_EXAMPLE = [
  '## Team plan estimate',
  'Drag the slider to see the **monthly price** for your team.',
  '{@body const [seats,setSeats] = DIL.useState(8)}',
  '{@body const price = seats*29}',
  '<box border padding={3} gap={2}>',
  '  <slider min={1} max={50} value={seats} onChange={setSeats}/>',
  '  <title size="xl">${price}/mo</title>',
  '</box>',
].join('\n')

test('the article example compiles into the captured constants table', () => {
  const result = compileDil(ARTICLE_EXAMPLE)
  assert.deepEqual(result.constants, {
    0: 'Team plan estimate',
    1: 'Drag the slider to see the ',
    2: 'monthly price',
    3: ' for your team.',
    4: '$',
    5: '/mo',
  })
})

test('the article example compiles into the captured program shape', () => {
  const { code } = compileDil(ARTICLE_EXAMPLE)
  // The prelude the capture opens with, verbatim.
  assert.match(code, /^function __dilSafe\(evaluate, failureValue\) \{ try \{ return evaluate\(\); \} catch \{ return failureValue; \} \}/)
  // Markup becomes plain calls to __dil.jsx, so no DIL parser is needed at runtime.
  assert.match(code, /DIL\.render\(__dil\.jsx\(\(\) => \{/)
  assert.match(code, /const __dilConstants = DIL\.useConstants\(\);/)
  assert.match(code, /const __dilModelDataBindings = DIL\.useAppData\(\(appData\) => appData\.opGenui\?\.modelDataBindings \?\? \{\}\);/)
  // Stable state keys: this is what makes state survive every recompilation.
  assert.match(code, /const \[seats,setSeats\] = DIL\.useState\(8, \{ key: "seats" \}\)/)
  // Derived values are isolated, so one bad expression removes one value.
  assert.match(code, /const price = __dilSafe\(\(\) => \(seats\*29\), undefined\);/)
  // Markdown lowers into the same tree as the components.
  assert.match(code, /__dil\.jsx\("title", \{ size: "lg" \}, __dilConstants\["0"\]\)/)
  assert.match(code, /__dil\.jsx\("bold", null, __dilConstants\["2"\]\)/)
  // The body key matches the capture's statement count.
  assert.match(code, /\}, \{ key: "body:2" \}\)\);/)
  // An element whose props are not all literals is wrapped for error isolation.
  assert.match(code, /__dilSafe\(\(\) => __dil\.jsx\("slider", \{ min: 1, max: 50,/)
})

test('the compiler never executes model output', () => {
  // A property expression that would leave a mark if the compiler evaluated
  // anything it was handed. It must survive as source text only.
  delete globalThis.__intelligentUiPwned
  const { code } = compileDil('<stat value={globalThis.__intelligentUiPwned = true}/>')
  assert.equal(globalThis.__intelligentUiPwned, undefined, 'the compiler ran model-written code')
  assert.match(code, /globalThis\.__intelligentUiPwned = true/, 'the expression was not preserved as source')

  // Attribute values are read by a hand-written literal parser, never `eval`.
  // Anything that is not a literal falls through to a runtime expression.
  assert.equal(parseLiteral('1 + 1').ok, false)
  assert.equal(parseLiteral('globalThis').ok, false)
  assert.equal(parseLiteral('"a" + "b"').ok, false)
  assert.equal(parseLiteral('process.exit(1)').ok, false)
  assert.equal(parseLiteral('{} + []').ok, false)
  assert.deepEqual(parseLiteral('{ a: [1, 2], b: "x", c: true }'), { ok: true, value: { a: [1, 2], b: 'x', c: true } })
  assert.deepEqual(parseLiteral('[1, 2.5, -3]'), { ok: true, value: [1, 2.5, -3] })
  assert.deepEqual(parseLiteral('"line\\nbreak"'), { ok: true, value: 'line\nbreak' })
  assert.equal(parseLiteral('{ a: 1, b: }').ok, false)
  assert.equal(parseLiteral('[1, 2').ok, false)

  // A non-literal attribute value becomes an expression in the program, and the
  // call-producing element is isolated so a throw there removes one element.
  const dynamic = compileDil('<slider max={Math.max(1, 2)}/>')
  assert.match(dynamic.code, /__dilSafe\(\(\) => __dil\.jsx\("slider", \{ max: \(Math\.max\(1, 2\)\) \}\), null\)/)
})

test('a half-written document still compiles', () => {
  const prefixes = []
  for (let length = 1; length <= ARTICLE_EXAMPLE.length; length += 1) {
    prefixes.push(ARTICLE_EXAMPLE.slice(0, length))
  }
  for (const prefix of prefixes) {
    const result = compileDil(prefix)
    assert.equal(typeof result.code, 'string', `prefix of length ${prefix.length} produced no program`)
    // A program that compiles must also be syntactically valid JavaScript.
    assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', result.code))
  }
})

test('an unfinished statement is dropped, not guessed at', () => {
  const result = compileDil('hello\n{@body const x = ')
  assert.ok(result.diagnostics.some((d) => d.code === 'dropped_incomplete'))
  assert.doesNotMatch(result.code, /const x/)
})

test('an unfinished tag is rolled back and open elements are closed', () => {
  const result = compileDil('<box border>\n  <title>Hi</title>\n  <slider min={')
  assert.ok(result.diagnostics.some((d) => d.code === 'unclosed_tag' && d.autoClosed === true))
  assert.match(result.code, /__dil\.jsx\("box", \{ border: true \}/)
  assert.match(result.code, /__dil\.jsx\("title", null, __dilConstants\["0"\]\)/)
  assert.doesNotMatch(result.code, /slider/)
})

test('catalog validation drops bad properties and records why', () => {
  const unknown = compileDil('<box border={true} sparkle="yes"/>')
  assert.deepEqual(
    unknown.diagnostics.filter((d) => d.code === 'unknown_prop'),
    [{ code: 'unknown_prop', component: 'box', prop: 'sparkle' }],
  )
  assert.doesNotMatch(unknown.code, /sparkle/)

  // The article reports this exact diagnostic: `gap="1"` on a box is an
  // invalid literal because the spacing scale is numeric.
  const literal = compileDil('<box gap="1"/>')
  assert.deepEqual(
    literal.diagnostics.filter((d) => d.code === 'invalid_literal'),
    [{ code: 'invalid_literal', component: 'box', prop: 'gap', expected: 'number 0..8', received: 'string' }],
  )
  assert.doesNotMatch(literal.code, /gap/)

  // A token spelled correctly survives.
  const good = compileDil('<row gap={1} radius="lg"><badge tone="success" variant="soft">ok</badge></row>')
  assert.deepEqual(good.diagnostics, [])
  assert.match(good.code, /gap: 1/)
  assert.match(good.code, /radius: "lg"/)
  assert.match(good.code, /tone: "success"/)

  // An enum outside its list is the same failure mode as a bad token.
  const offList = compileDil('<badge tone="chartreuse">no</badge>')
  assert.deepEqual(offList.diagnostics, [{
    code: 'invalid_literal', component: 'badge', prop: 'tone',
    expected: '"neutral" | "muted" | "brand" | "success" | "warn" | "error" | "info"',
    received: 'string',
  }])
})

test('key is a reconciler concern, not a component property', () => {
  const result = compileDil('<box key="a"><text key="b">hi</text></box>')
  assert.deepEqual(result.diagnostics, [])
  assert.match(result.code, /key: "a"/)
})

test('markdown lowers into the same tree as the components', () => {
  const { children } = lowerDocument([
    '# Title',
    '',
    'A paragraph with **bold**, *italic*, `code` and a [link](https://x.test).',
    '',
    '- one',
    '- two',
    '',
    '> quoted',
    '',
    '---',
    '',
    '```js',
    'const answer = 42',
    '```',
  ].join('\n'))
  const kinds = children.map((child) => child.tag)
  assert.deepEqual(kinds, ['title', 'text', 'list', 'quote', 'divider', 'codeblock'])
  assert.equal(children[0].props[0].value, '2xl')
  const inline = children[1].children.map((child) => child.kind === 'el' ? child.tag : '#text')
  assert.deepEqual(inline, ['#text', 'bold', '#text', 'italic', '#text', 'code', '#text', 'link', '#text'])
  assert.deepEqual(children[2].children.map((child) => child.tag), ['item', 'item'])
  assert.equal(children[5].props[0].value, 'js')
})

test('interpolation splits text into constants and expressions', () => {
  const result = compileDil('<text>Total: ${a + b} items</text>')
  // The `$` stays in the text, exactly as the article's capture shows for
  // `${price}/mo` — constants "4": "$" and "5": "/mo" around the expression.
  assert.deepEqual(result.constants, { 0: 'Total: $', 1: ' items' })
  assert.match(result.code, /__dilSafe\(\(\) => \(a \+ b\), null\)/)
})

test('dynamic lists can be built with DIL.h', () => {
  const result = compileDil('<box>${items.map((it) => DIL.h("text", { key: it.id }, it.label))}</box>')
  assert.match(result.code, /items\.map\(\(it\) => DIL\.h\("text", \{ key: it\.id \}, it\.label\)\)/)
})

test('composites compile into a called function', () => {
  const { code, diagnostics } = compileComposite('<row gap={2}><title>${name}</title></row>', ['name'])
  assert.match(code, /^function \(props\) \{/)
  assert.match(code, /const \{ name \} = props \|\| \{\};/)
  assert.match(code, /__dil\.jsx\("title", null, "\$", __dilSafe\(\(\) => \(name\), null\)\)/)
  assert.deepEqual(diagnostics, [])
})

test('fallbackMarkdown keeps the prose and drops the notation', () => {
  const markdown = fallbackMarkdown(ARTICLE_EXAMPLE)
  assert.match(markdown, /Team plan estimate/)
  assert.match(markdown, /Drag the slider to see the \*\*monthly price\*\* for your team\./)
  assert.doesNotMatch(markdown, /<box/)
  assert.doesNotMatch(markdown, /\{@body/)
  assert.doesNotMatch(markdown, /\$\{/)
})

test('a document with no components is still a valid, empty program', () => {
  const result = compileDil('Just prose.')
  assert.equal(result.stats.nodes, 1)
  assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', result.code))
})
