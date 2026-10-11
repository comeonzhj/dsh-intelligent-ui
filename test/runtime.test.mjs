/**
 * The reconciler and the sandbox runner.
 *
 * The runtime's contract has three parts worth holding down: it encodes the
 * tree as operations rather than markup, an interaction is answered locally,
 * and a program that fails leaves the previous one on screen.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { compileDil } from '../lib/compile.js'
import { createDilRuntime, decodeTree, OP, ROOT_ID } from '../src/runtime/runtime.js'

/**
 * A human-readable dump of one operation batch, in the article's own shape: one
 * line per node, with its properties, its text and its placement.
 *
 * `types` is carried across batches so an incremental update still reads as
 * `UPDATE #10 slider SET value = 9` rather than a bare node id.
 */
function dump(batch, types = new Map()) {
  const order = []
  const info = new Map()
  const record = (id) => {
    if (!info.has(id)) {
      info.set(id, { id, created: false, type: types.get(id), sets: [], text: undefined, place: undefined })
      order.push(id)
    }
    return info.get(id)
  }

  for (const op of batch.ops) {
    switch (op[0]) {
      case OP.CREATE: {
        const entry = record(op[1])
        entry.created = true
        entry.type = batch.strings[op[2]]
        types.set(op[1], entry.type)
        break
      }
      case OP.SET: {
        const tag = op[3][0]
        const value = tag === 5 ? 'fn'
          : tag === 3 ? JSON.stringify(batch.strings[op[3][1]])
            : tag === 2 ? String(op[3][1] === 1)
              : tag === 0 ? 'nil'
                : op[3][1]
        record(op[1]).sets.push(`SET ${batch.strings[op[2]]} = ${value}`)
        break
      }
      case OP.TEXT:
        record(op[1]).text = JSON.stringify(batch.strings[op[2]])
        break
      case OP.PLACE:
        record(op[1]).place = `PLACE under ${op[2] === ROOT_ID ? 'root' : `#${op[2]}`} at ${op[3]}`
        break
      case OP.REMOVE:
        record(op[1]).removed = true
        break
      default:
        break
    }
  }

  return order.map((id) => {
    const entry = info.get(id)
    const head = entry.created ? `CREATE #${id} ${entry.type}` : `UPDATE #${id} ${entry.type ?? '?'}`
    return [
      head,
      ...entry.sets,
      entry.text === undefined ? null : `TEXT ${entry.text}`,
      entry.removed ? 'REMOVE' : entry.place,
    ].filter(Boolean).join(' ')
  })
}

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

function load(source) {
  const compiled = compileDil(source)
  const runtime = createDilRuntime()
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  return { runtime, compiled, batch }
}

test('a first render produces the article operation stream', () => {
  const { batch } = load(ARTICLE_EXAMPLE)
  assert.equal(batch.ok, true)
  const lines = dump(batch)
  // One line per node, in the reference document's shape. The only difference
  // is the `#root` wrapper the reconciler keeps so it always has one stable
  // node to diff against.
  assert.deepEqual(lines, [
    'CREATE #1 #root PLACE under root at 0',
    'CREATE #2 title SET size = "lg" PLACE under #1 at 0',
    'CREATE #3 #text TEXT "Team plan estimate" PLACE under #2 at 0',
    'CREATE #4 text PLACE under #1 at 1',
    'CREATE #5 #text TEXT "Drag the slider to see the " PLACE under #4 at 0',
    'CREATE #6 bold PLACE under #4 at 1',
    'CREATE #7 #text TEXT "monthly price" PLACE under #6 at 0',
    'CREATE #8 #text TEXT " for your team." PLACE under #4 at 2',
    'CREATE #9 box SET border = true SET padding = 3 SET gap = 2 PLACE under #1 at 2',
    'CREATE #10 slider SET min = 1 SET max = 50 SET value = 8 SET onChange = fn PLACE under #9 at 0',
    'CREATE #11 title SET size = "xl" PLACE under #9 at 1',
    'CREATE #12 #text TEXT "$" PLACE under #11 at 0',
    'CREATE #13 #text TEXT "232" PLACE under #11 at 1',
    'CREATE #14 #text TEXT "/mo" PLACE under #11 at 2',
  ])
  // The program's own value for 8 × 29 lands as a text node, exactly as the
  // capture's `#12 text "232"` does.
  assert.ok(batch.strings.includes('232'))
})

test('operations are integers plus a string table, never markup', () => {
  const { batch } = load(ARTICLE_EXAMPLE)
  for (const op of batch.ops) {
    assert.ok(Array.isArray(op), 'each operation is an array')
    assert.equal(typeof op[0], 'number')
    for (const part of op.slice(1)) {
      assert.ok(['number', 'string', 'object'].includes(typeof part))
    }
  }
  // No operation carries a blob of HTML or CSS.
  for (const text of batch.strings) assert.doesNotMatch(text, /<\/?[a-z]+[\s>]/i)
})

test('an interaction is answered locally, with no new program', () => {
  const { runtime, batch, compiled } = load(ARTICLE_EXAMPLE)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const seen = []
  const types = new Map()
  dump(batch, types)
  decodeTree(batch, { root, onHandler: (id) => { seen.push(id); return () => {} } })
  assert.equal(seen.length, 1, 'the slider published exactly one handler')

  // The user drags the slider to 9.
  const next = runtime.dispatch({ handler: seen[0], args: [9] })
  assert.equal(next.ok, true)
  const lines = dump(next, types)
  // Only the two nodes that changed: the bound value, and the derived price.
  assert.deepEqual(lines, [
    'UPDATE #10 slider SET value = 9',
    'UPDATE #13 #text TEXT "261"',
  ])
  // Still the same program.
  assert.equal(compiled.code.includes('seats*29'), true)
})

test('hook state survives a recompilation', () => {
  const compiled = compileDil([
    '<box><slider value={n} onChange={setN}/><title>${n}</title></box>',
    '{@body const [n, setN] = DIL.useState(4)}',
  ].join('\n'))
  const runtime = createDilRuntime()
  const first = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const seen = []
  decodeTree(first, { root, onHandler: (id) => { seen.push(id); return () => {} } })
  runtime.dispatch({ handler: seen[0], args: [7] })

  // The model revises the card: same state key, a different program. The value
  // the user set must survive, which is the point of the keyed slots.
  const revised = compileDil([
    '<box><slider value={n} onChange={setN}/><title>${n}</title><text>extra</text></box>',
    '{@body const [n, setN] = DIL.useState(4)}',
  ].join('\n'))
  const second = runtime.loadProgram({ code: revised.code, constants: revised.constants })
  assert.equal(second.ok, true)
  assert.ok(second.strings.includes('7'), 'the value the user chose, not the initial one')
  assert.ok(!second.strings.includes('4'))
})

test('a failing expression removes one element, not the render', () => {
  const compiled = compileDil('<box><title>ok</title><stat value={missing.deep}/><title>after</title></box>')
  const runtime = createDilRuntime()
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  assert.equal(batch.ok, true)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root })
  const texts = [...nodes.values()].filter((node) => node.type === '#text').map((node) => node.text)
  assert.deepEqual(texts, ['ok', 'after'], 'the siblings survived the bad expression')
  // The failing element is simply absent.
  assert.equal([...nodes.values()].some((node) => node.type === 'stat'), false)
})

test('a program that throws leaves the previous one on screen', () => {
  const runtime = createDilRuntime()
  const good = compileDil('<title>version one</title>')
  const first = runtime.loadProgram({ code: good.code, constants: good.constants })
  assert.equal(first.ok, true)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(first, { root })
  const textOf = () => [...nodes.values()].filter((node) => node.text !== null).map((node) => node.text)
  assert.deepEqual(textOf(), ['version one'])

  // A syntactically broken program, as a truncated stream can produce.
  const broken = runtime.loadProgram({ code: 'DIL.render(', constants: {} })
  assert.equal(broken.ok, false)
  assert.equal(typeof broken.error.message, 'string')

  // Settling again still renders version one, and emits no removals.
  const settled = runtime.settle(false)
  assert.equal(settled.ok, true)
  assert.deepEqual(settled.ops, [])
  decodeTree(settled, { nodes, root })
  assert.deepEqual(textOf(), ['version one'])
})

test('a program that never renders is rejected', () => {
  const runtime = createDilRuntime()
  const result = runtime.loadProgram({ code: 'const unused = 1;', constants: {} })
  assert.equal(result.ok, false)
  assert.match(result.error.message, /did not call DIL\.render/)
})

test('decodeTree replays a batch onto an existing tree', () => {
  const { runtime, batch } = load('<box><title>one</title><title>two</title></box>')
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root })
  // The runtime always reconciles one wrapper node, so the page has a stable
  // parent to diff against; the card's own content hangs below it.
  assert.equal(root.children.length, 1)
  const wrapper = root.children[0]
  assert.equal(wrapper.type, '#root')
  assert.equal(wrapper.children.length, 1)
  const box = wrapper.children[0]
  assert.equal(box.type, 'box')
  assert.equal(box.children.length, 2)
  assert.equal(box.children[0].children[0].text, 'one')

  // Re-decode onto the same store; ids are stable so nothing is duplicated.
  decodeTree(batch, { nodes, root })
  assert.equal(nodes.size, batch.ops.filter((op) => op[0] === OP.CREATE).length)
})

test('keyed children survive reordering', () => {
  const runtime = createDilRuntime()
  // Reordering inside one program, so the diff runs against a live tree.
  const compiled = compileDil([
    '<box>',
    '  <segmented options={["asc","desc"]} value={order} onChange={setOrder}/>',
    '  <row>{items.map((it) => DIL.h("text", { key: it }, it))}</row>',
    '</box>',
    '{@body const [order, setOrder] = DIL.useState("asc")}',
    '{@body const items = order === "asc" ? ["a","b","c"] : ["c","b","a"]}',
  ].join('\n'))
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  assert.equal(batch.ok, true)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const seen = []
  const nodes = decodeTree(batch, { root, onHandler: (id) => { seen.push(id); return () => {} } })
  const read = () => {
    const box = root.children[0].children[0]
    const row = box.children.find((child) => child.type === 'row')
    return row.children.map((child) => child.children[0].text)
  }
  assert.deepEqual(read(), ['a', 'b', 'c'])

  const next = runtime.dispatch({ handler: seen[0], args: ['desc'] })
  assert.equal(next.ok, true)
  decodeTree(next, { nodes, root })
  assert.deepEqual(read(), ['c', 'b', 'a'], 'keys drive the new order, not types')
  // Every row is reused: the batch moves nodes instead of recreating them.
  assert.equal(next.ops.filter((op) => op[0] === OP.CREATE).length, 0)
  assert.ok(next.ops.some((op) => op[0] === OP.PLACE), 'reordering is expressed as PLACE')
})
