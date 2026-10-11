/**
 * Intelligent UI — chart options.
 *
 * The `chart` component lowers the model's data into an Apache ECharts option.
 * Kept as a pure function of `(node, tokens)` so the mapping can be tested
 * without a DOM or a canvas: the renderer's only remaining job is to hand the
 * result to an instance.
 *
 * Series and category shapes are deliberately forgiving. A model writing a bar
 * chart should be able to pass `[3, 5, 2]`, `[{x:"Q1", y:3}]` or
 * `[{name:"Q1", value:3}]` and get the same picture.
 *
 * @module intelligent-ui/src/client/chart
 */

/** Chart families the vendored ECharts build can actually draw. */
export const CHART_TYPES = Object.freeze(['bar', 'line', 'area', 'pie', 'donut', 'scatter'])

/** Cartesian families, i.e. the ones that need axes. */
const CARTESIAN = new Set(['bar', 'line', 'area', 'scatter'])

/** Number formatting shared with the rest of the card. */
function format(value, mode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
  if (mode === 'currency') return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (mode === 'percent') return `${value}%`
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/**
 * Normalize one series' data.
 *
 * @returns `{ points, names }` — `points` are `[x, y]` pairs for a cartesian
 *   family, or `{name, value}` items for pie/donut.
 */
function normalizeData(data, pie) {
  const list = Array.isArray(data) ? data : []
  const points = []
  const names = []
  list.forEach((entry, index) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const name = entry.name ?? entry.label ?? entry.x
      const value = Number(entry.value ?? entry.y ?? 0)
      const tone = entry.tone
      points.push(pie ? { name: name === undefined ? String(index) : String(name), value, tone } : [name === undefined ? index : name, value])
      names.push(name === undefined ? String(index) : String(name))
      return
    }
    if (Array.isArray(entry)) {
      points.push([entry[0], Number(entry[1]) || 0])
      names.push(String(entry[0]))
      return
    }
    points.push(pie ? { name: String(index), value: Number(entry) || 0 } : [index, Number(entry) || 0])
    names.push(String(index))
  })
  return { points, names }
}

/** Turn the catalog's series list into ECharts series, one per entry. */
function normalizeSeries(raw, fallbackType, tokens, pie) {
  const list = Array.isArray(raw) ? raw : []
  return list.map((entry, index) => {
    const source = entry !== null && typeof entry === 'object' ? entry : { data: entry }
    const spoken = source.type === undefined ? fallbackType : String(source.type)
    const family = pie ? (spoken === 'donut' ? 'pie' : spoken) : spoken
    const { points } = normalizeData(source.data, pie)
    const tone = source.tone
    return {
      name: source.name === undefined ? '' : String(source.name),
      family,
      points,
      color: tone === undefined ? tokens.palette[index % tokens.palette.length] : tokens.tone(tone),
      smooth: source.smooth === true,
      stacked: source.stacked === true,
      area: family === 'area' || source.area === true,
      dashed: source.dashed === true,
      symbolSize: family === 'scatter' ? Number(source.symbolSize ?? 9) : undefined,
    }
  })
}

/**
 * Build one ECharts option.
 *
 * @param props - the `chart` node's properties.
 * @param tokens - resolved literal colours and a `tone(name)` resolver, because
 *   a canvas cannot read `var(--dsw-*)`.
 * @returns a plain ECharts option object.
 */
export function buildChartOption(props, tokens) {
  const type = CHART_TYPES.includes(props.type) ? props.type : 'bar'
  const pie = type === 'pie' || type === 'donut'
  const horizontal = props.horizontal === true && CARTESIAN.has(type) && type !== 'scatter'
  const stacked = props.stacked === true
  const format$ = props.valueFormat

  const series = normalizeSeries(props.series, type, tokens, pie)
  // Chart-level conveniences, so a document does not have to repeat itself on
  // every series.
  for (const entry of series) {
    if (props.smooth === true) entry.smooth = true
    if (props.area === true && (entry.family === 'line' || entry.family === 'area')) entry.area = true
  }
  const categories = Array.isArray(props.categories) ? props.categories.map(String) : null

  const option = {
    animationDuration: 1800,
    animationEasing: 'cubicOut',
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'inherit', color: tokens.label },
    grid: { left: 8, right: 12, top: props.legend ? 34 : 12, bottom: 4, containLabel: true },
    tooltip: {
      trigger: pie ? 'item' : 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: tokens.surface,
      borderColor: tokens.border,
      textStyle: { color: tokens.strong, fontSize: 12 },
      valueFormatter: (value) => format(value, format$),
    },
    // A pie earns a legend from its first slice; a cartesian chart only once
    // there is more than one series to tell apart.
    legend: props.legend === true && (pie || series.length > 1)
      ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 9, itemHeight: 9, textStyle: { color: tokens.label, fontSize: 11 } }
      : undefined,
  }

  if (pie) {
    // A single unnamed series is the normal case; extra series become rings.
    const rings = series.length > 0 ? series : [{ points: [], color: tokens.palette[0] }]
    option.series = rings.map((entry, index) => ({
      type: 'pie',
      name: entry.name,
      radius: type === 'donut'
        ? [`${48 + index * 12}%`, `${68 + index * 12}%`]
        : ['0%', `${68 + index * 12}%`],
      center: ['50%', props.legend ? '56%' : '52%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: tokens.surface, borderWidth: 2 },
      label: { show: props.labels !== false, color: tokens.label, fontSize: 11, formatter: '{b} {d}%' },
      labelLine: { show: props.labels !== false, length: 8, length2: 8, lineStyle: { color: tokens.border } },
      data: entry.points.map((point, pointIndex) => ({
        name: point.name,
        value: point.value,
        // A slice takes its own tone when it declared one, so a status breakdown
        // can read success/warn/error without a legend.
        itemStyle: { color: point.tone === undefined ? tokens.palette[pointIndex % tokens.palette.length] : tokens.tone(point.tone) },
      })),
    }))
    return option
  }

  const axisCategory = categories ?? series[0]?.points.map((point) => String(point[0])) ?? []
  const valueAxis = {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: tokens.grid, type: 'dashed' } },
    axisLabel: { color: tokens.muted, fontSize: 10, formatter: (value) => format(value, format$) },
  }
  const categoryAxis = {
    type: 'category',
    data: axisCategory,
    boundaryGap: type === 'bar',
    axisLine: { lineStyle: { color: tokens.border } },
    axisTick: { show: false },
    axisLabel: { color: tokens.muted, fontSize: 10, hideOverlap: true },
  }

  option.xAxis = horizontal ? valueAxis : categoryAxis
  option.yAxis = horizontal ? categoryAxis : valueAxis

  option.series = series.map((entry) => {
    const family = entry.family === 'area' ? 'line' : entry.family
    const base = {
      type: family === 'donut' ? 'pie' : family,
      name: entry.name,
      // A horizontal bar is grouped by [value, category], so a point that only
      // carried an index has to be resolved back to its category label.
      data: horizontal && family !== 'scatter'
        ? entry.points.map((point, index) => [point[1], axisCategory[index] ?? String(point[0])])
        : entry.points.map((point) => (family === 'scatter' ? point : point[1])),
      itemStyle: { color: entry.color, borderRadius: family === 'bar' && !stacked ? 3 : 0 },
      stack: stacked || entry.stacked ? 'total' : undefined,
      emphasis: { focus: 'series' },
    }
    if (family === 'line' || family === 'area') {
      base.smooth = entry.smooth
      base.showSymbol = props.symbols !== false
      base.symbolSize = 6
      base.lineStyle = { width: 2, color: entry.color, type: entry.dashed ? 'dashed' : 'solid' }
      if (entry.area) {
        base.areaStyle = { opacity: 0.16, color: entry.color }
      }
    }
    if (family === 'scatter') {
      base.symbolSize = entry.symbolSize ?? 9
      base.itemStyle = { color: entry.color, opacity: 0.85 }
    }
    return base
  })

  // Long category axes get a zoom strip rather than an unreadable axis.
  if (!horizontal && type !== 'scatter' && axisCategory.length > 24) {
    option.dataZoom = [{ type: 'inside' }, { type: 'slider', height: 14, bottom: 0, borderColor: tokens.border, fillerColor: tokens.zoom }]
    option.grid.bottom = 26
  }
  if (props.min !== undefined || props.max !== undefined) {
    const target = horizontal ? option.xAxis : option.yAxis
    target.min = props.min
    target.max = props.max
  }
  return option
}

/**
 * Normalize a `sparkline` series into `[x, y]` points: the micro-chart keeps its
 * own inline SVG, because spinning up a chart instance for a 28px line is worse
 * than drawing one.
 */
export function sparklinePoints(data) {
  const list = Array.isArray(data) ? data : []
  return list.map((entry, index) => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return { x: Number(entry.x ?? index), y: Number(entry.y ?? entry.value ?? 0) }
    }
    if (Array.isArray(entry)) return { x: Number(entry[0]), y: Number(entry[1]) || 0 }
    return { x: index, y: Number(entry) || 0 }
  })
}

/**
 * The literal colours ECharts needs.
 *
 * A canvas cannot resolve `var(--dsw-*)`, so the tokens are read from the live
 * document once per mount and handed over as hex/rgb strings.
 */
export function readTokens(resolve, tone) {
  const palette = [
    resolve('--dsw-alias-state-business-primary', '#2f6bff'),
    resolve('--dsw-alias-state-success-primary', '#12854a'),
    resolve('--dsw-alias-state-warn-primary', '#b06a00'),
    resolve('--dsw-alias-state-error-primary', '#c62828'),
    resolve('--dsw-alias-state-idle-primary', '#3b6fd4'),
    resolve('--dsw-alias-brand-primary', '#7d5cff'),
  ]
  return {
    strong: resolve('--dsw-alias-label-primary', '#1b1f27'),
    label: resolve('--dsw-alias-label-secondary', '#5a6474'),
    muted: resolve('--dsw-alias-label-tertiary', '#8a93a3'),
    border: resolve('--dsw-alias-border-l2', 'rgba(20,26,40,0.10)'),
    grid: resolve('--dsw-alias-border-l1', 'rgba(20,26,40,0.06)'),
    surface: resolve('--dsw-alias-bg-layer-1', '#ffffff'),
    zoom: resolve('--dsw-alias-brand-primary', '#2f6bff'),
    palette,
    tone: (name) => {
      const map = {
        neutral: resolve('--dsw-alias-label-secondary', '#5a6474'),
        muted: resolve('--dsw-alias-label-tertiary', '#8a93a3'),
        brand: resolve('--dsw-alias-state-business-primary', '#2f6bff'),
        success: resolve('--dsw-alias-state-success-primary', '#12854a'),
        warn: resolve('--dsw-alias-state-warn-primary', '#b06a00'),
        error: resolve('--dsw-alias-state-error-primary', '#c62828'),
        info: resolve('--dsw-alias-state-idle-primary', '#3b6fd4'),
      }
      return map[name] ?? map.neutral
    },
  }
}
