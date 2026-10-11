/**
 * The chart mapping.
 *
 * The renderer's only job is to hand an option to an ECharts instance, so the
 * interesting logic — how the model's data becomes series and axes — is a pure
 * function and is tested here, without a DOM or a canvas.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildChartOption, readTokens, sparklinePoints, CHART_TYPES } from '../src/client/chart.js'
import { COMPONENTS } from '../lib/catalog.js'
import { compileDil } from '../lib/compile.js'
import { createDilRuntime, decodeTree, ROOT_ID } from '../src/runtime/runtime.js'

/** Literal tokens, as `readTokens` would produce from a live document. */
const tokens = readTokens((_name, fallback) => fallback)

const option = (props) => buildChartOption(props, tokens)

test('the offered types are exactly what the vendored build can draw', () => {
  assert.deepEqual([...CHART_TYPES], ['bar', 'line', 'area', 'pie', 'donut', 'scatter'])
  // The catalog and the option builder must agree, or the model can ask for a
  // chart that silently renders as a bar.
  const declared = COMPONENTS.chart.props.type.values
  assert.deepEqual([...declared].sort(), [...CHART_TYPES].sort())
})

test('a bar chart gets categories and one series', () => {
  const spec = option({ type: 'bar', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Revenue', data: [3, 5, 2] }] })
  assert.deepEqual(spec.xAxis.data, ['Q1', 'Q2', 'Q3'])
  assert.equal(spec.yAxis.type, 'value')
  assert.equal(spec.series.length, 1)
  assert.equal(spec.series[0].type, 'bar')
  assert.deepEqual(spec.series[0].data, [3, 5, 2])
  assert.equal(spec.series[0].name, 'Revenue')
})

test('categories are derived from the first series when omitted', () => {
  const spec = option({ type: 'bar', series: [{ data: [{ x: 'Mon', y: 1 }, { x: 'Tue', y: 4 }] }] })
  assert.deepEqual(spec.xAxis.data, ['Mon', 'Tue'])
  assert.deepEqual(spec.series[0].data, [1, 4])
})

test('several series group, and stack on request', () => {
  const grouped = option({ type: 'bar', series: [{ name: 'A', data: [1, 2] }, { name: 'B', data: [3, 4] }], legend: true })
  assert.equal(grouped.series.length, 2)
  assert.equal(grouped.series[0].stack, undefined)
  assert.notEqual(grouped.series[0].itemStyle.color, grouped.series[1].itemStyle.color, 'series must be told apart')
  assert.ok(grouped.legend !== undefined, 'two series earn a legend')

  const stacked = option({ type: 'bar', stacked: true, series: [{ name: 'A', data: [1, 2] }, { name: 'B', data: [3, 4] }] })
  assert.equal(stacked.series[0].stack, 'total')
  assert.equal(stacked.series[1].stack, 'total')
})

test('a horizontal bar swaps the axes', () => {
  const spec = option({ type: 'bar', horizontal: true, categories: ['a', 'b'], series: [{ data: [1, 2] }] })
  assert.equal(spec.xAxis.type, 'value')
  assert.equal(spec.yAxis.type, 'category')
  // ECharts groups horizontal bars by [value, category].
  assert.deepEqual(spec.series[0].data, [[1, 'a'], [2, 'b']])
})

test('lines are smooth, filled and dashed on request', () => {
  const spec = option({
    type: 'line',
    smooth: true,
    area: true,
    series: [{ name: 'A', data: [1, 3, 2] }, { name: 'B', data: [2, 1, 4], dashed: true }],
  })
  assert.equal(spec.series[0].type, 'line')
  assert.equal(spec.series[0].smooth, true)
  // A chart-level `area` fills every line series...
  assert.ok(spec.series[0].areaStyle !== undefined, 'area fill is missing')
  assert.ok(spec.series[1].areaStyle !== undefined, 'a chart-level `area` applies to every line series')
  // ...while `dashed` is per series. What reaches ECharts is the line style,
  // not the input spelling.
  assert.equal(spec.series[1].lineStyle.type, 'dashed')
  assert.equal(spec.series[0].lineStyle.type, 'solid')
})

test('`area` is line-with-fill, whichever way it is asked for', () => {
  const byType = option({ type: 'area', series: [{ data: [1, 2] }] })
  assert.equal(byType.series[0].type, 'line')
  assert.ok(byType.series[0].areaStyle !== undefined)
  const perSeries = option({ type: 'line', series: [{ data: [1, 2], area: true }] })
  assert.ok(perSeries.series[0].areaStyle !== undefined)
})

test('a per-series type mixes families in one chart', () => {
  const spec = option({
    type: 'bar',
    categories: ['Q1', 'Q2'],
    series: [{ name: 'Revenue', data: [3, 5] }, { name: 'Trend', type: 'line', data: [4, 4] }],
  })
  assert.deepEqual(spec.series.map((entry) => entry.type), ['bar', 'line'])
  assert.equal(spec.type, undefined, 'the option itself carries no type')
})

test('a pie becomes one series and a donut becomes a ring', () => {
  const pie = option({ type: 'pie', series: [{ data: [{ name: 'a', value: 3 }, { name: 'b', value: 1 }] }] })
  assert.equal(pie.series[0].type, 'pie')
  assert.equal(pie.series[0].radius[0], '0%')
  assert.deepEqual(pie.series[0].data.map((slice) => [slice.name, slice.value]), [['a', 3], ['b', 1]])
  assert.equal(pie.xAxis, undefined, 'a pie has no axes')

  const donut = option({ type: 'donut', series: [{ data: [{ name: 'a', value: 3 }] }] })
  assert.notEqual(donut.series[0].radius[0], '0%')
})

test('a slice takes its own tone', () => {
  const spec = option({
    type: 'donut',
    series: [{ data: [{ name: 'ok', value: 3, tone: 'success' }, { name: 'bad', value: 1, tone: 'error' }] }],
  })
  assert.deepEqual(spec.series[0].data.map((slice) => slice.itemStyle.color), [
    tokens.tone('success'),
    tokens.tone('error'),
  ])
})

test('scatter reads x/y pairs', () => {
  const spec = option({ type: 'scatter', series: [{ name: 'p', data: [[1, 2], [3, 5]], symbolSize: 12 }] })
  assert.equal(spec.series[0].type, 'scatter')
  assert.equal(spec.series[0].symbolSize, 12)
  assert.deepEqual(spec.series[0].data, [[1, 2], [3, 5]])
})

test('a long category axis earns a zoom strip', () => {
  const short = option({ type: 'bar', series: [{ data: Array.from({ length: 20 }, (_, i) => i) }] })
  assert.equal(short.dataZoom, undefined)
  const long = option({ type: 'bar', series: [{ data: Array.from({ length: 40 }, (_, i) => i) }] })
  assert.ok(Array.isArray(long.dataZoom), 'a 40-point axis needs a zoom strip')
})

test('bounds and number formatting reach the axis and the tooltip', () => {
  const spec = option({
    type: 'bar',
    valueFormat: 'currency',
    min: 0,
    max: 100,
    series: [{ data: [10, 20] }],
  })
  assert.equal(spec.yAxis.min, 0)
  assert.equal(spec.yAxis.max, 100)
  assert.equal(spec.tooltip.valueFormatter(1234), `$${Number(1234).toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
  assert.match(spec.yAxis.axisLabel.formatter(50), /^\$/)
})

test('an unknown type falls back to bar rather than rendering nothing', () => {
  const spec = option({ type: 'sankey', series: [{ data: [1] }] })
  assert.equal(spec.series[0].type, 'bar')
})

test('the props survive the operation wire, and the option keeps its formatters', () => {
  // The card's data arrives as JSON, so the *props* have to be JSON-safe...
  const props = {
    type: 'bar',
    categories: ['a', 'b'],
    series: [{ name: 'A', data: [1, 2] }],
    legend: true,
    min: 0,
    max: 10,
  }
  assert.deepEqual(JSON.parse(JSON.stringify(props)), props)

  // ...while the option deliberately does not: its number formatters are
  // functions, which is exactly why the renderer keys its re-apply on the
  // serialized props rather than on the option itself.
  const spec = option({ ...props, valueFormat: 'currency' })
  assert.equal(typeof spec.tooltip.valueFormatter, 'function')
  assert.equal(typeof spec.yAxis.axisLabel.formatter, 'function')
  assert.equal(spec.tooltip.valueFormatter(5), '$5')
})

test('a chart in DIL lowers to a chart node with its data intact', () => {
  const compiled = compileDil([
    '<chart',
    '  type="bar"',
    '  categories={["Q1","Q2"]}',
    '  series={[{name:"Revenue", data:[3, 5]}, {name:"Cost", type:"line", data:[1, 2]}]}',
    '  legend={true}',
    '  height={180}',
    '/>',
  ].join('\n'))
  assert.deepEqual(compiled.diagnostics, [])
  const runtime = createDilRuntime()
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  assert.equal(batch.ok, true, batch.error?.message)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root })
  const chart = [...nodes.values()].find((node) => node.type === 'chart')
  assert.ok(chart !== undefined, 'the chart did not survive the wire')
  assert.equal(chart.props.type, 'bar')
  assert.equal(chart.props.height, 180)
  assert.equal(chart.props.legend, true)
  assert.equal(chart.props.series.length, 2)
  assert.equal(chart.props.series[1].type, 'line')
  // And the data it arrived with is what the option builder consumes.
  assert.equal(buildChartOption(chart.props, tokens).series.length, 2)
})

test('sparkline points accept numbers, pairs and objects', () => {
  assert.deepEqual(sparklinePoints([1, 2, 3]), [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }])
  assert.deepEqual(sparklinePoints([[0, 5], [1, 7]]), [{ x: 0, y: 5 }, { x: 1, y: 7 }])
  assert.deepEqual(sparklinePoints([{ x: 2, y: 9 }]), [{ x: 2, y: 9 }])
  assert.deepEqual(sparklinePoints(undefined), [])
})

test('the token reader trusts its resolver, which owns the fallbacks', () => {
  // `readTokens` takes a `(name, fallback) => string` resolver; picking the
  // fallback is the resolver's job, which is what makes this testable without
  // a document.
  const empty = readTokens((_name, fallback) => fallback)
  assert.equal(empty.strong, '#1b1f27')
  assert.ok(Array.isArray(empty.palette) && empty.palette.length > 2)
  const custom = readTokens((name, fallback) => (name === '--dsw-alias-label-primary' ? 'rgb(1, 2, 3)' : fallback))
  assert.equal(custom.strong, 'rgb(1, 2, 3)')
  assert.equal(custom.tone('success'), '#12854a')
  assert.equal(custom.tone('nonsense'), custom.tone('neutral'))
})
