/**
 * Intelligent UI — the catalog.
 *
 * The catalog is what the model is allowed to ask for. It exists because the
 * model does not build an interface from raw layout and styling rules: it picks
 * components this client already knows how to draw and styles them with design
 * tokens (`padding={3}`, `size="lg"`, `tone="success"`). Raw CSS values are
 * accepted for a few properties, but tokens are preferred.
 *
 * Two consumers, one source of truth:
 *
 *   * the compiler validates every written property against `props` and drops
 *     what does not fit, recording a diagnostic (`unknown_prop`,
 *     `invalid_literal`) — exactly what OpenAI's compiler does;
 *   * the renderer draws each component with the harness design system.
 *
 * This module is deliberately dependency-free so the Host half can import it,
 * the browser half can inline it, and the sandboxed runtime can read it.
 *
 * @module intelligent-ui/lib/catalog
 */

/** Spacing scale, in steps. `padding={3}` is 12px. */
export const SPACE = Object.freeze({ 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64 })

/** Corner scale. */
export const RADIUS = Object.freeze({
  none: '0px', sm: '8px', md: '12px', lg: '16px', xl: '20px', panel: '28px', full: '999px',
})

/** Type scale. */
export const SIZE = Object.freeze({
  xs: '11px', sm: '12px', md: '14px', lg: '16px', xl: '20px', '2xl': '26px', '3xl': '34px',
})

/** Font weight scale. */
export const WEIGHT = Object.freeze({
  regular: 400, medium: 500, semibold: 600, bold: 700,
})

/** Semantic colour roles. Every one resolves to a harness design token. */
export const TONE = Object.freeze([
  'neutral', 'muted', 'brand', 'success', 'warn', 'error', 'info',
])

/** Main-axis distribution. */
export const JUSTIFY = Object.freeze(['start', 'center', 'end', 'between', 'around'])

/** Cross-axis alignment. */
export const ALIGN = Object.freeze(['start', 'center', 'end', 'stretch', 'baseline'])

/** Sentence case label for a token, used when generating the catalog text. */
function keys(object) {
  return Object.keys(object).join(' | ')
}

/* ------------------------------------------------------------------ *
 * Property descriptors
 * ------------------------------------------------------------------ */

const num = (description, extra) => ({ t: 'num', description, ...extra })
const bool = (description) => ({ t: 'bool', description })
const str = (description) => ({ t: 'str', description })
const any = (description) => ({ t: 'any', description })
const fn = (description) => ({ t: 'fn', description })
const space = (description) => ({ t: 'token', scale: 'space', valueType: 'number', description })
const radius = (description) => ({ t: 'token', scale: 'radius', valueType: 'string', description })
const size = (description) => ({ t: 'token', scale: 'size', valueType: 'string', description })
const weight = (description) => ({ t: 'token', scale: 'weight', valueType: 'string', description })
const tone = (description) => ({ t: 'enum', values: TONE, description })
const oneOf = (values, description) => ({ t: 'enum', values, description })
const listOf = (item, description) => ({ t: 'array', item, description })

/**
 * Shared property fragments. Composing these keeps a component's contract
 * short to read and makes the "raw CSS value allowed here" cases explicit —
 * `css` is the only escape into literal styling, and the catalog text tells the
 * model to prefer tokens.
 */
const P = {
  padding: space('Inner spacing step.'),
  gap: space('Space between children.'),
  border: bool('Draw a hairline border.'),
  radius: radius('Corner rounding token.'),
  background: oneOf(['none', 'base', 'layer-1', 'layer-2', 'layer-3', 'overlay'], 'Surface token.'),
  tone: tone('Semantic colour role.'),
  align: oneOf(ALIGN, 'Cross-axis alignment.'),
  justify: oneOf(JUSTIFY, 'Main-axis distribution.'),
  wrap: bool('Wrap onto multiple lines.'),
  grow: bool('Take the remaining main-axis space.'),
  width: oneOf(['auto', 'full', 'half', 'third', 'twothirds'], 'Relative width.'),
  css: str('Raw CSS escape hatch. Prefer tokens.'),
  label: str('Visible label.'),
  name: str('Field name. Named controls are collected into the answer this card sends back.'),
  disabled: bool('Render inactive and ignore interaction.'),
  onChange: fn('Handler called with the next value.'),
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

/**
 * Every component the model may use, its accepted properties, whether it takes
 * children, and one line of guidance. Native components are drawn by the
 * client; composite ones are written in DIL and shipped prebuilt to the
 * sandbox (see `lib/composite.js`).
 */
export const COMPONENTS = {
  /* ---- layout ---- */
  box: {
    doc: 'Vertical stack. The general container.',
    children: 'any',
    props: {
      padding: P.padding, gap: P.gap, border: P.border, radius: P.radius,
      background: P.background, align: P.align, justify: P.justify,
      grow: P.grow, width: P.width, css: P.css,
    },
  },
  row: {
    doc: 'Horizontal stack of items.',
    children: 'any',
    props: {
      padding: P.padding, gap: P.gap, align: P.align, justify: P.justify,
      wrap: P.wrap, border: P.border, radius: P.radius, background: P.background,
      grow: P.grow, css: P.css,
    },
  },
  grid: {
    doc: 'Even grid; `columns` sets the track count.',
    children: 'any',
    props: { columns: num('Track count, 1–6.', { min: 1, max: 6 }), gap: P.gap, padding: P.padding, css: P.css },
  },
  card: {
    doc: 'Elevated surface for one grouped idea.',
    children: 'any',
    props: { title: P.label, padding: P.padding, gap: P.gap, tone: P.tone, css: P.css },
  },
  divider: {
    doc: 'Hairline separator, optionally labelled.',
    children: 'none',
    props: { label: P.label, spacing: P.padding },
  },
  spacer: { doc: 'Fixed empty space.', children: 'none', props: { size: space('Vertical space step.') } },
  scroll: {
    doc: 'Scrollable region with a height cap.',
    children: 'any',
    props: { height: num('Height in px.', { min: 40 }), maxHeight: num('Max height in px.', { min: 40 }) },
  },
  tabs: {
    doc: 'Tab strip over `tab` children. Local state; no model round trip.',
    children: 'any',
    props: { value: str('Active tab id; bind to state for control.'), onChange: P.onChange },
  },
  tab: {
    doc: 'One panel inside `tabs`.',
    children: 'any',
    props: { id: str('Stable id, matched against `tabs.value`.'), label: P.label },
  },
  reveal: {
    doc: 'Collapsible disclosure; id-less, keeps its own open state.',
    children: 'any',
    props: { title: P.label, open: bool('Start expanded.') },
  },
  columns: {
    doc: 'Two side-by-side panes with independent widths.',
    children: 'any',
    props: { ratio: oneOf(['1:1', '2:1', '1:2', '3:1', '1:3'], 'Width ratio.'), gap: P.gap },
  },

  /* ---- typography ---- */
  title: {
    doc: 'Heading. Markdown `#`/`##`/`###` compile into this.',
    children: 'text',
    props: { size: size('Type scale.'), tone: P.tone, align: oneOf(ALIGN, 'Text alignment.') },
  },
  text: {
    doc: 'Body copy. Markdown paragraphs compile into this.',
    children: 'any',
    props: {
      size: size('Type scale.'), tone: P.tone, weight: weight('Font weight.'),
      align: oneOf(ALIGN, 'Text alignment.'), mono: bool('Monospaced.'),
    },
  },
  bold: { doc: 'Strong emphasis.', children: 'any', props: { tone: P.tone } },
  italic: { doc: 'Italic emphasis.', children: 'any', props: {} },
  code: { doc: 'Inline code span.', children: 'text', props: { tone: P.tone } },
  math: {
    doc: 'LaTeX formula, rendered offline as native MathML. Inline by default; display puts it on its own line. Use tex, not children or dollar delimiters; double backslashes in quoted strings.',
    children: 'none',
    props: {
      tex: str('LaTeX source, at most 8192 characters. Escape each backslash in quoted DIL strings, or bind a String.raw expression.'),
      display: bool('Render as a centred, horizontally scrollable block; default false (inline).'),
      size: size('Type scale. Omit to inherit the surrounding font size.'),
      tone: P.tone,
    },
  },
  caption: { doc: 'Small secondary line, e.g. a source or a footnote.', children: 'any', props: { tone: P.tone } },
  label: { doc: 'Form-field label.', children: 'text', props: { tone: P.tone } },
  link: {
    doc: 'External or in-page link.',
    children: 'text',
    props: { href: str('Destination URL.'), onClick: P.onChange },
  },
  kbd: { doc: 'Keyboard key.', children: 'text', props: {} },
  quote: { doc: 'Quoted passage with a leading rule.', children: 'any', props: { cite: str('Attribution.') } },
  callout: {
    doc: 'Tinted note. Use `tone` for its role.',
    children: 'any',
    props: { title: P.label, tone: P.tone, icon: str('Leading glyph or icon name.') },
  },
  list: {
    doc: 'Bulleted or numbered list of `item` children.',
    children: 'any',
    props: { ordered: bool('Number the items.'), gap: P.gap },
  },
  item: { doc: 'One list entry.', children: 'any', props: { marker: str('Custom bullet text.') } },

  /* ---- controls: interacting with these never calls the model ---- */
  slider: {
    doc: 'Continuous range input.',
    children: 'none',
    props: {
      min: num('Lower bound.'), max: num('Upper bound.'), step: num('Increment.', { min: 0 }),
      value: num('Current value; bind to state.'), onChange: P.onChange,
      label: P.label, name: P.name, unit: str('Unit suffix, e.g. " seats".'),
      format: oneOf(['number', 'currency', 'percent'], 'Number formatting.'),
      marks: bool('Show min/max labels.'),
    },
  },
  switch: {
    doc: 'Boolean toggle.',
    children: 'none',
    props: { checked: bool('Current value.'), label: P.label, name: P.name, onChange: P.onChange, disabled: P.disabled },
  },
  checkbox: {
    doc: 'Boolean checkbox, optionally in a card row.',
    children: 'none',
    props: { checked: bool('Current value.'), label: P.label, name: P.name, description: str('Secondary line.'), onChange: P.onChange, disabled: P.disabled },
  },
  radio: {
    doc: 'Single choice from `options`.',
    children: 'none',
    props: { options: listOf(any(''), 'Choices: strings, or {value,label,description}.'), value: any('Current value.'), onChange: P.onChange, name: P.name },
  },
  segmented: {
    doc: 'Compact single choice from 2–5 `options`.',
    children: 'none',
    props: { options: listOf(any(''), 'Choices: strings, or {value,label}.'), value: any('Current value.'), onChange: P.onChange, name: P.name },
  },
  select: {
    doc: 'Dropdown single choice. Use `segmented` for 2–5 options.',
    children: 'none',
    props: { options: listOf(any(''), 'Choices.'), value: any('Current value.'), onChange: P.onChange, placeholder: str('Empty-state text.'), label: P.label, name: P.name },
  },
  input: {
    doc: 'Single-line text field.',
    children: 'none',
    props: { value: str('Current value; bind to state for control.'), onChange: P.onChange, placeholder: str('Empty-state text.'), label: P.label, name: P.name, disabled: P.disabled },
  },
  textarea: {
    doc: 'Multi-line text field.',
    children: 'none',
    props: { value: str('Current value.'), onChange: P.onChange, placeholder: str('Empty-state text.'), label: P.label, name: P.name, rows: num('Visible rows.', { min: 2, max: 12 }) },
  },
  stepper: {
    doc: 'Numeric field with minus/plus buttons.',
    children: 'none',
    props: { value: num('Current value.'), onChange: P.onChange, min: num('Lower bound.'), max: num('Upper bound.'), step: num('Increment.', { min: 0 }), label: P.label, name: P.name },
  },
  rating: {
    doc: 'Star rating.',
    children: 'none',
    props: { max: num('Star count.', { min: 1, max: 10 }), value: num('Current value.'), onChange: P.onChange, label: P.label, name: P.name },
  },
  field: {
    doc: 'Declares one name/value pair for the card answer without drawing anything. Composite components use it to make their selection part of the answer.',
    children: 'none',
    props: { name: str('Field name in the answer.'), value: any('Value handed back with the answer.') },
  },
  option: {
    doc: 'One selectable tile. `choiceCard` composes these; reach for it directly only when you need a custom layout.',
    children: 'none',
    props: {
      label: P.label, description: str('Secondary line under the label.'),
      meta: str('Short right-aligned detail, e.g. a price.'),
      value: any('Opaque value handed to `onClick`.'),
      selected: bool('Draw as the current selection.'),
      tone: P.tone, disabled: P.disabled, onClick: P.onChange,
    },
  },
  button: {
    doc: 'One action. `submit` sends the card answer back to the model; `event` just raises `onClick`.',
    children: 'none',
    props: {
      label: P.label,
      variant: oneOf(['primary', 'secondary', 'ghost', 'outline', 'danger'], 'Visual weight.'),
      onClick: P.onChange, disabled: P.disabled,
      submit: bool('Send this card’s answer to the model as the user’s reply.'),
      action: str('Opaque payload handed to `onClick` when clicked.'),
    },
  },
  actions: {
    doc: 'Row of `button` children, right-aligned.',
    children: 'any',
    props: { align: oneOf(['start', 'center', 'end', 'between'], 'Distribution.'), gap: P.gap },
  },
  form: {
    doc: 'Collects every named control inside it and hands them to `onSubmit` / submit buttons.',
    children: 'any',
    props: { onSubmit: P.onChange, gap: P.gap, padding: P.padding, submitLabel: str('Label of the generated submit button.') },
  },

  /* ---- data display ---- */
  table: {
    doc: 'Tabular data. `columns` are headers or {key,label,align} objects.',
    children: 'none',
    props: {
      columns: listOf(any(''), 'Header labels or {key,label,align} objects.'),
      rows: listOf(any(''), 'Row arrays or objects keyed by column key.'),
      striped: bool('Zebra rows.'), compact: bool('Denser rows.'), caption: str('Table caption.'),
    },
  },
  kv: {
    doc: 'Definition list of label/value pairs.',
    children: 'none',
    props: { items: listOf(any(''), 'Array of {label, value, tone?}.'), columns: num('Layout columns.', { min: 1, max: 3 }) },
  },
  stat: {
    doc: 'One headline number with a label and an optional delta.',
    children: 'none',
    props: {
      label: P.label, value: any('The headline value.'), unit: str('Unit suffix.'),
      delta: str('Change, e.g. "+12%".'), trend: oneOf(['up', 'down', 'flat'], 'Direction of the delta.'),
      tone: P.tone, help: str('Explanatory line.'),
    },
  },
  progress: {
    doc: 'Progress or quota bar.',
    children: 'none',
    props: { value: num('Current value.'), max: num('Value at full width.'), label: P.label, tone: P.tone, showValue: bool('Print the percentage.') },
  },
  badge: {
    doc: 'Small inline status chip.',
    children: 'text',
    props: { tone: P.tone, variant: oneOf(['solid', 'soft', 'outline'], 'Fill style.'), dot: bool('Leading status dot.') },
  },
  pill: { doc: 'Neutral chip, for tags and metadata.', children: 'text', props: { tone: P.tone } },
  avatar: {
    doc: 'Person or entity mark.',
    children: 'none',
    props: { src: str('Image URL.'), name: str('Name; drives the initial fallback.'), size: oneOf(['sm', 'md', 'lg'], 'Diameter.') },
  },
  image: {
    doc: 'One image with an optional caption.',
    children: 'none',
    props: { src: str('Image URL.'), alt: str('Alternative text.'), caption: str('Caption below.'), ratio: oneOf(['auto', '1:1', '4:3', '16:9', '3:2'], 'Aspect box.'), radius: P.radius },
  },
  gallery: {
    doc: 'Image grid from `items` ({src, alt, caption?}).',
    children: 'none',
    props: { items: listOf(any(''), 'Image objects.'), columns: num('Track count.', { min: 1, max: 4 }), ratio: oneOf(['1:1', '4:3', '16:9'], 'Aspect box.') },
  },
  icon: {
    doc: 'A named glyph from the harness icon set.',
    children: 'none',
    props: { name: str('Icon name, e.g. "check", "search", "sparkle".'), tone: P.tone, size: size('Glyph size.') },
  },
  chart: {
    doc: 'A real chart, drawn with Apache ECharts. Data comes from the card, never from a network call; the canvas re-colours itself when the theme flips.',
    children: 'none',
    props: {
      type: oneOf(['bar', 'line', 'area', 'pie', 'donut', 'scatter'], 'Default family for every series.'),
      series: listOf(any(''), 'Series objects: {name, type?, data, tone?, smooth?, stacked?, area?, dashed?, symbolSize?}. `data` accepts numbers, {x,y}, {name,value} or [x,y]. A per-series `type` lets one chart mix families, e.g. bars with a line on top.'),
      categories: listOf(any(''), 'Category labels for bar/line/area/scatter. Derived from the first series when omitted.'),
      height: num('Plot height in px.', { min: 60, max: 420 }),
      stacked: bool('Stack every bar/area series into one band.'),
      legend: bool('Show the legend.'),
      horizontal: bool('Lay bar charts out left-to-right.'),
      smooth: bool('Draw every line series as a smoothed curve.'),
      area: bool('Fill under every line series.'),
      symbols: bool('Draw a symbol on each line point.'),
      labels: bool('Label pie and donut slices.'),
      min: num('Lower bound of the value axis.'),
      max: num('Upper bound of the value axis.'),
      valueFormat: oneOf(['number', 'currency', 'percent'], 'Number formatting for axes, tooltips and labels.'),
    },
  },
  sparkline: {
    doc: 'Inline micro-chart for a number series. Drawn as one SVG path, not a chart instance.',
    children: 'none',
    props: {
      data: listOf(any(''), 'Numbers, [x,y] pairs, or {x,y} points.'),
      tone: P.tone,
      height: num('Height in px.', { min: 16, max: 80 }),
      area: bool('Fill under the line.'),
      last: bool('Mark the final point.'),
    },
  },
  timeline: {
    doc: 'Vertical event timeline from `items`.',
    children: 'none',
    props: { items: listOf(any(''), 'Array of {title, time?, body?, tone?}.'), compact: bool('Denser rows.') },
  },
  steps: {
    doc: 'Numbered steps with a completion state.',
    children: 'none',
    props: { steps: listOf(any(''), 'Array of {title, body?, done?}.'), current: num('Active index, 0-based.') },
  },
  codeblock: {
    doc: 'Fenced code. Markdown fences compile into this.',
    children: 'text',
    props: { language: str('Language hint.'), filename: str('Optional filename header.'), wrap: bool('Soft-wrap long lines.') },
  },
  json: { doc: 'Collapsible JSON value.', children: 'none', props: { value: any('Any JSON value.'), label: P.label } },

  /* ---- composite components, written in DIL and shipped prebuilt ---- */
  statRow: {
    doc: 'Composite: a row of `stat` tiles from `items` ({label, value, unit?, delta?, trend?, tone?}).',
    children: 'none',
    composite: true,
    props: { items: listOf(any(''), 'Stat descriptors.'), columns: num('Tiles per row.', { min: 1, max: 4 }) },
  },
  pricingCard: {
    doc: 'Composite: one plan tile — name, headline price, feature list, call to action.',
    children: 'none',
    composite: true,
    props: {
      name: str('Plan name.'), price: any('Headline price.'), period: str('Billing period, e.g. "/mo".'),
      features: listOf(any(''), 'Feature strings.'), featured: bool('Highlight as the recommended plan.'),
      name: P.name, action: any('Payload raised by the call-to-action button.'), onChange: P.onChange,
    },
  },
  productCard: {
    doc: 'Composite: image, title, price, rating and a call to action.',
    children: 'none',
    composite: true,
    props: {
      image: str('Image URL.'), title: str('Product name.'), price: str('Price text.'),
      wasPrice: str('Struck-through previous price.'), rating: num('0–5 rating.', { min: 0, max: 5 }),
      reviews: num('Review count.'), badgeText: str('Corner chip text.'),
      name: P.name, action: any('Payload raised by the call-to-action button.'), onChange: P.onChange,
    },
  },
  choiceCard: {
    doc: 'Composite: the recommended way to ask the human to choose. Options become selectable tiles; the submit button sends the choice back to the model.',
    children: 'none',
    composite: true,
    props: {
      options: listOf(any(''), 'Array of {value, label, description?, meta?, tone?}.'),
      value: any('Selected value; bind to state.'),
      onChange: P.onChange,
      name: P.name,
      prompt: str('Question shown above the tiles.'),
      submitLabel: str('Accepted for convenience; the submit control belongs to the card\u2019s answer footer, so this only labels it.'),
      allowNote: bool('Offer a free-text note box. Defaults to true.'),
    },
  },
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function describeLiteral(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function literalFits(spec, value) {
  switch (spec.t) {
    case 'bool': return typeof value === 'boolean'
    case 'num': return typeof value === 'number' && Number.isFinite(value)
    case 'str': return typeof value === 'string'
    case 'any': return true
    case 'fn': return true
    case 'token':
      if (typeof value !== spec.valueType) return false
      return Object.prototype.hasOwnProperty.call(scaleTable(spec.scale), value)
    case 'enum': return spec.values.includes(value)
    case 'array': return Array.isArray(value)
    default: return true
  }
}

/** The token table behind a `token` descriptor. */
export function scaleTable(scale) {
  switch (scale) {
    case 'space': return SPACE
    case 'radius': return RADIUS
    case 'size': return SIZE
    case 'weight': return WEIGHT
    default: return {}
  }
}

/** The token names a `token` descriptor accepts, as written in DIL. */
export function scaleNames(scale) {
  const table = scaleTable(scale)
  const valueType = SCALE_VALUE_TYPE[scale] ?? 'string'
  return Object.keys(table).map((key) => (valueType === 'number' ? key : `"${key}"`))
}

/** How a token scale's keys must be written: `padding={3}` vs `radius="lg"`. */
export const SCALE_VALUE_TYPE = Object.freeze({
  space: 'number', radius: 'string', size: 'string', weight: 'string',
})

/**
 * Validate one element's written properties against the catalog.
 *
 * Mirrors the compiler behaviour described for ChatGPT's Intelligent UI: a
 * property that does not exist on a component, or a literal of the wrong type,
 * is removed and recorded as a diagnostic rather than failing the render.
 *
 * @param component - tag name as written.
 * @param props - parsed props (values already evaluated where they were expressions).
 * @returns `{ props, diagnostics }` with only the surviving properties.
 */
export function validateProps(component, props) {
  const definition = COMPONENTS[component]
  const diagnostics = []
  if (definition === undefined) {
    return { props: {}, diagnostics: [{ code: 'unknown_component', component }] }
  }
  const kept = {}
  for (const [key, value] of Object.entries(props)) {
    // `key` is a reconciler concern, not a component property: every component
    // accepts it so dynamic lists can address their children.
    if (key === 'key') { kept[key] = value; continue }
    const spec = definition.props[key]
    if (spec === undefined) {
      diagnostics.push({ code: 'unknown_prop', component, prop: key })
      continue
    }
    if (value === undefined) continue
    if (!literalFits(spec, value)) {
      diagnostics.push({
        code: 'invalid_literal', component, prop: key,
        expected: describeExpected(spec),
        received: describeLiteral(value),
      })
      continue
    }
    kept[key] = value
  }
  return { props: kept, diagnostics }
}

/**
 * How a property's accepted values read in prose.
 *
 * The same wording serves the catalog text and the diagnostic the compiler
 * records, so a dropped property and the documentation agree.
 */
export function describeExpected(spec) {
  switch (spec.t) {
    case 'bool': return 'true | false'
    case 'num': return 'number'
    case 'str': return 'string'
    case 'any': return 'any'
    case 'fn': return 'handler'
    case 'enum': return spec.values.map((value) => (typeof value === 'string' ? `"${value}"` : String(value))).join(' | ')
    case 'array': return 'array'
    case 'token': {
      const table = scaleTable(spec.scale)
      const keys = Object.keys(table)
      if (spec.valueType === 'number') return `number ${keys[0]}..${keys[keys.length - 1]}`
      return keys.map((key) => `"${key}"`).join(' | ')
    }
    default: return spec.t
  }
}

/** The property names a component accepts, in declaration order. */
export function componentPropNames(name) {
  const definition = COMPONENTS[name]
  return definition === undefined ? [] : Object.keys(definition.props)
}

/** Whether a tag name is a known component. */
export function isComponent(name) {
  return Object.prototype.hasOwnProperty.call(COMPONENTS, name)
}

/** Every component name, sorted. */
export function componentNames() {
  return Object.keys(COMPONENTS).sort()
}

/* ------------------------------------------------------------------ *
 * Catalog text for the system prompt
 * ------------------------------------------------------------------ */

function propText(spec) {
  if (spec.t === 'num' && (spec.min !== undefined || spec.max !== undefined)) {
    return `number ${spec.min ?? ''}..${spec.max ?? ''}`.trim()
  }
  if (spec.t === 'bool') return 'bool'
  // Enums and tokens read the same here as in a diagnostic, so the catalog and
  // the compiler report a dropped property in identical words.
  return describeExpected(spec)
}

/**
 * Render the catalog as compact prompt text.
 *
 * `detail: 'full'` prints every property of every component; `compact` prints
 * names, children and one line each, which is what a small-context deployment
 * wants.
 */
export function catalogText(detail = 'full') {
  const groups = [
    ['Layout', ['box', 'row', 'grid', 'card', 'divider', 'spacer', 'scroll', 'tabs', 'tab', 'reveal', 'columns']],
    ['Text', ['title', 'text', 'bold', 'italic', 'code', 'math', 'caption', 'label', 'link', 'kbd', 'quote', 'callout', 'list', 'item']],
    ['Controls', ['slider', 'switch', 'checkbox', 'radio', 'segmented', 'select', 'input', 'textarea', 'stepper', 'rating', 'option', 'field', 'button', 'actions', 'form']],
    ['Data', ['table', 'kv', 'stat', 'progress', 'badge', 'pill', 'avatar', 'image', 'gallery', 'icon', 'chart', 'sparkline', 'timeline', 'steps', 'codeblock', 'json']],
    ['Composite', ['statRow', 'pricingCard', 'productCard', 'choiceCard']],
  ]
  const out = []
  for (const [groupName, names] of groups) {
    out.push(`### ${groupName}`)
    for (const name of names) {
      const definition = COMPONENTS[name]
      if (definition === undefined) continue
      const children = definition.children === 'none' ? '' : ' …children'
      if (detail === 'full') {
        const props = Object.entries(definition.props)
          .map(([key, spec]) => `${key}=${propText(spec)}`)
          .join('  ')
        out.push(`- \`<${name}>${children}\` — ${definition.doc}`)
        out.push(`  props: ${props.length > 0 ? props : '(none)'}`)
      } else {
        out.push(`- \`<${name}>${children}\` — ${definition.doc}`)
      }
    }
  }
  out.push('### Tokens')
  out.push(`- spacing: ${keys(SPACE)}  (step → px: ${Object.entries(SPACE).map(([k, v]) => `${k}=${v}`).join(' ')})`)
  out.push(`- radius: ${keys(RADIUS)}`)
  out.push(`- size: ${keys(SIZE)}`)
  out.push(`- weight: ${keys(WEIGHT)}`)
  out.push(`- tone: ${TONE.join(' | ')}`)
  return out.join('\n')
}
