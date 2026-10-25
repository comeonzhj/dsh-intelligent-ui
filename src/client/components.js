/**
 * Intelligent UI — the renderer.
 *
 * The runtime produces operations, never markup. This module applies them to
 * this client's own component tree: each node type from the catalog becomes a
 * real element styled with the harness design system, so a generated interface
 * looks like the rest of DeepSeek Harness on every platform.
 *
 * Two rules follow from that:
 *
 *   * only catalog types are drawn — an unknown type renders a small
 *     "unsupported" placeholder rather than arbitrary markup;
 *   * styling goes through `--dsw-alias-*` tokens (with literal fallbacks), so
 *     light and dark themes both come out right.
 *
 * @module intelligent-ui/src/client/components
 */

import { SPACE, RADIUS, SIZE, WEIGHT } from '../../lib/catalog.js'
import { buildChartOption, readTokens } from './chart.js'
import { MAX_MATH_LENGTH } from './math.js'
import { renderMathIsolated } from './math-worker.js'

/**
 * Whether this bundle carries the vendored chart runtime.
 *
 * The loader is a function (see `scripts/build-client.mjs`), so nothing of
 * ECharts runs until a card actually draws a chart. A `typeof` test rather than
 * a direct read, because this module is also imported by the Node tests.
 */
const HAS_CHARTS = typeof __IUI_ECHARTS_LOAD !== 'undefined'

/** Load the vendored runtime once, or `null` when it is absent or broken. */
function chartRuntime() {
  if (!HAS_CHARTS) return null
  try {
    return __IUI_ECHARTS_CACHE !== null ? __IUI_ECHARTS_CACHE : __IUI_ECHARTS_LOAD()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * Token helpers
 * ------------------------------------------------------------------ */

const spaceOf = (step) => (step === undefined || step === null ? undefined : `${SPACE[step] ?? 0}px`)
const radiusOf = (token) => (token === undefined ? undefined : RADIUS[token] ?? RADIUS.md)

/** Palette roles, resolved through harness tokens with literal fallbacks. */
const TONE_MAP = {
  neutral: { fg: 'var(--dsw-alias-label-primary, #1b1f27)', bg: 'transparent', line: 'transparent' },
  muted: { fg: 'var(--dsw-alias-label-secondary, #5a6474)', bg: 'transparent', line: 'transparent' },
  brand: {
    fg: 'var(--dsw-alias-state-business-primary, #2f6bff)',
    bg: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6bff) 12%, transparent)',
    line: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #2f6bff) 34%, transparent)',
  },
  success: {
    fg: 'var(--dsw-alias-state-success-primary, #12854a)',
    bg: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #12854a) 12%, transparent)',
    line: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #12854a) 34%, transparent)',
  },
  warn: {
    fg: 'var(--dsw-alias-state-warn-primary, #b06a00)',
    bg: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b06a00) 14%, transparent)',
    line: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b06a00) 36%, transparent)',
  },
  error: {
    fg: 'var(--dsw-alias-state-error-primary, #c62828)',
    bg: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #c62828) 12%, transparent)',
    line: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #c62828) 34%, transparent)',
  },
  info: {
    fg: 'var(--dsw-alias-state-idle-primary, #3b6fd4)',
    bg: 'color-mix(in srgb, var(--dsw-alias-state-idle-primary, #3b6fd4) 12%, transparent)',
    line: 'color-mix(in srgb, var(--dsw-alias-state-idle-primary, #3b6fd4) 34%, transparent)',
  },
}

const toneOf = (name) => TONE_MAP[name] ?? TONE_MAP.neutral

const SURFACE = {
  none: 'transparent',
  base: 'var(--dsw-alias-bg-base, #ffffff)',
  'layer-1': 'var(--dsw-alias-bg-layer-1, #ffffff)',
  'layer-2': 'var(--dsw-alias-bg-layer-2, #f5f6f9)',
  'layer-3': 'var(--dsw-alias-bg-layer-3, #eceef4)',
  overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
}

const HAIRLINE = '0.5px'
const BORDER = 'var(--dsw-alias-border-l2, rgba(20, 26, 40, 0.10))'
const TEXT_PRIMARY = 'var(--dsw-alias-label-primary, #1b1f27)'
const TEXT_SECONDARY = 'var(--dsw-alias-label-secondary, #5a6474)'
const TEXT_TERTIARY = 'var(--dsw-alias-label-tertiary, #8a93a3)'
const BRAND = 'var(--dsw-alias-brand-primary, #2f6bff)'
const ELEVATION = 'var(--dsw-elevation-panel, 0 0 0 0.5px rgba(20,26,40,.10), 0 3px 8px rgba(0,0,0,.05))'

/** Format a number the way the card asked for it. */
function formatNumber(value, mode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '')
  if (mode === 'currency') {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value) } catch { return `$${value}` }
  }
  if (mode === 'percent') return `${Number(value.toFixed(1))}%`
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

/** Normalize `["a","b"] | [{value,label}]` option lists. */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return []
  return options.map((option, index) => {
    if (option !== null && typeof option === 'object') {
      return {
        value: option.value ?? option.label ?? index,
        label: option.label ?? String(option.value ?? index),
        description: option.description,
        meta: option.meta,
      }
    }
    return { value: option, label: String(option), description: undefined, meta: undefined }
  })
}

/* ------------------------------------------------------------------ *
 * Chart theming
 * ------------------------------------------------------------------ */

/** Resolve one harness token to a literal colour, with a literal fallback. */
function resolveToken(name, fallback) {
  if (typeof document === 'undefined' || document.body === null) return fallback
  const value = getComputedStyle(document.body).getPropertyValue(name)
  const trimmed = value === undefined || value === null ? '' : value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Light or dark, as the harness marks it on `<body>`. */
function themeKey() {
  if (typeof document === 'undefined' || document.body === null) return 'light'
  return document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
}

const themeListeners = new Set()
let themeObserver = null
let lastThemeKey = null

/** Watch the body attribute the theme plugin flips, so open charts re-colour. */
function subscribeTheme(listener) {
  if (typeof document !== 'undefined' && typeof MutationObserver === 'function' && themeObserver === null) {
    themeObserver = new MutationObserver(() => {
      const next = themeKey()
      if (next === lastThemeKey) return
      lastThemeKey = next
      for (const callback of themeListeners) {
        try { callback() } catch { /* one listener must not break the others */ }
      }
    })
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
  }
  themeListeners.add(listener)
  return () => themeListeners.delete(listener)
}

let tokenCache = { key: null, value: null }

/** The literal tokens ECharts needs, rebuilt only when the theme changes. */
function chartTokens() {
  const key = themeKey()
  if (tokenCache.key !== key || tokenCache.value === null) {
    tokenCache = { key, value: readTokens(resolveToken) }
  }
  return tokenCache.value
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

/**
 * Build the renderer set.
 * @param React - the host's React (from the client module table).
 * @returns `{ renderNode, collectAnswers, components }`.
 */
export function createRenderers(React) {
  const h = React.createElement
  const Fragment = React.Fragment
  // A stable hook, defined once so the call order never depends on the host.
  const useThemeKey = typeof React.useSyncExternalStore === 'function'
    ? () => React.useSyncExternalStore(subscribeTheme, themeKey, () => 'light')
    : () => 'light'

  /** Recurse into a node's children. */
  const kids = (node, ctx) => node.children.map((child) => ctx.render(child))

  /**
   * Pick only the properties a DOM element should see. Props that belong to
   * the catalog but not the DOM (`key`, `name`, `onChange`) never leak out.
   */
  const dom = (props, allowed) => {
    const out = {}
    for (const name of allowed) {
      const value = props[name]
      if (value !== undefined && value !== null) out[name] = value
    }
    return out
  }

  const text = (node, ctx) => (node.text === null || node.text === undefined ? null : node.text)

  /* ---- layout ---- */

  const box = (node, ctx) => {
    const p = node.props
    const style = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: p.align === 'stretch' || p.align === undefined ? 'stretch' : alignValue(p.align),
      justifyContent: justifyValue(p.justify),
      gap: spaceOf(p.gap),
      padding: spaceOf(p.padding),
      borderRadius: radiusOf(p.radius),
      background: SURFACE[p.background] ?? undefined,
      border: p.border ? `${HAIRLINE} solid ${BORDER}` : undefined,
      flex: p.grow ? '1 1 auto' : undefined,
      minWidth: 0,
      width: widthValue(p.width),
    }
    if (p.background === 'layer-2' || p.background === 'layer-3') style.border = style.border ?? 'none'
    return h('div', { key: node.id, className: 'iui-node', style: merge(style, rawCss(p.css)) }, ...kids(node, ctx))
  }

  const row = (node, ctx) => {
    const p = node.props
    const style = {
      display: 'flex',
      flexDirection: 'row',
      alignItems: alignValue(p.align) ?? 'center',
      justifyContent: justifyValue(p.justify),
      flexWrap: p.wrap ? 'wrap' : undefined,
      gap: spaceOf(p.gap),
      padding: spaceOf(p.padding),
      borderRadius: radiusOf(p.radius),
      background: SURFACE[p.background] ?? undefined,
      border: p.border ? `${HAIRLINE} solid ${BORDER}` : undefined,
      flex: p.grow ? '1 1 auto' : undefined,
      minWidth: 0,
    }
    return h('div', { key: node.id, className: 'iui-node', style: merge(style, rawCss(p.css)) }, ...kids(node, ctx))
  }

  const grid = (node, ctx) => {
    const p = node.props
    const columns = Math.max(1, Math.min(6, Number(p.columns) || 2))
    return h('div', {
      key: node.id,
      className: 'iui-node',
      style: merge({
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: spaceOf(p.gap) ?? '8px',
        padding: spaceOf(p.padding),
        minWidth: 0,
      }, rawCss(p.css)),
    }, ...kids(node, ctx))
  }

  const card = (node, ctx) => {
    const p = node.props
    const accent = p.tone === undefined || p.tone === 'neutral' ? null : toneOf(p.tone)
    return h('div', {
      key: node.id,
      className: 'iui-node iui-card',
      style: merge({
        display: 'flex',
        flexDirection: 'column',
        gap: spaceOf(p.gap) ?? '12px',
        padding: spaceOf(p.padding) ?? '16px',
        borderRadius: RADIUS.lg,
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        border: 0,
        boxShadow: accent === null ? ELEVATION : `inset 0 0 0 1px ${accent.line}, ${ELEVATION}`,
        minWidth: 0,
      }, rawCss(p.css)),
    },
      p.title === undefined ? null : h('div', { key: 'title', style: { fontWeight: WEIGHT.semibold, fontSize: SIZE.md, color: TEXT_PRIMARY } }, String(p.title)),
      ...kids(node, ctx))
  }

  const divider = (node) => {
    const p = node.props
    if (p.label === undefined) {
      return h('div', { key: node.id, style: { height: HAIRLINE, background: BORDER, margin: `${spaceOf(p.spacing) ?? '12px'} 0` } })
    }
    return h('div', {
      key: node.id,
      style: { display: 'flex', alignItems: 'center', gap: '8px', margin: `${spaceOf(p.spacing) ?? '12px'} 0` },
    },
      h('div', { key: 'line', style: { flex: '1 1 auto', height: HAIRLINE, background: BORDER } }),
      h('span', { key: 'label', style: { fontSize: SIZE.sm, color: TEXT_TERTIARY } }, String(p.label)),
      h('div', { key: 'line2', style: { flex: '1 1 auto', height: HAIRLINE, background: BORDER } }))
  }

  const spacer = (node) => h('div', { key: node.id, style: { height: spaceOf(node.props.size) ?? '8px' } })

  const scroll = (node, ctx) => h('div', {
    key: node.id,
    className: 'iui-node',
    style: { overflowY: 'auto', height: node.props.height, maxHeight: node.props.maxHeight, minWidth: 0 },
  }, ...kids(node, ctx))

  const tabs = (node, ctx) => {
    const p = node.props
    const panels = node.children.filter((child) => child.type === 'tab')
    const active = p.value ?? (panels[0] === undefined ? undefined : panels[0].props.id)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { key: 'strip', style: { display: 'flex', gap: '4px', borderBottom: `${HAIRLINE} solid ${BORDER}` } },
        panels.map((panel) => h('button', {
          key: panel.id,
          type: 'button',
          onClick: () => { if (typeof p.onChange === 'function') p.onChange(panel.props.id) },
          style: {
            appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer',
            padding: '6px 10px', fontSize: SIZE.md, fontFamily: 'inherit',
            color: panel.props.id === active ? TEXT_PRIMARY : TEXT_SECONDARY,
            fontWeight: panel.props.id === active ? WEIGHT.semibold : WEIGHT.regular,
            borderBottom: panel.props.id === active ? `2px solid ${BRAND}` : '2px solid transparent',
            marginBottom: '-1px',
          },
        }, panel.props.label === undefined ? String(panel.props.id ?? '') : String(panel.props.label)))),
      ...panels.filter((panel) => panel.props.id === active).map((panel) => h(Fragment, { key: `p-${panel.id}` }, ...panel.children.map((child) => ctx.render(child)))))
  }

  const tab = (node, ctx) => h(Fragment, { key: node.id }, ...kids(node, ctx))

  const reveal = (node, ctx) => {
    const [open, setOpen] = React.useState(Boolean(node.props.open))
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('button', {
        key: 'head',
        type: 'button',
        onClick: () => setOpen(!open),
        style: {
          appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', gap: '8px', fontSize: SIZE.md, fontFamily: 'inherit',
          color: TEXT_PRIMARY, fontWeight: WEIGHT.medium, textAlign: 'left',
        },
      },
        h('span', { key: 'chev', style: { display: 'inline-block', transition: 'transform .18s ease', transform: open ? 'rotate(90deg)' : 'none', color: TEXT_TERTIARY } }, '›'),
        node.props.title === undefined ? null : String(node.props.title)),
      open ? h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '18px' } }, ...kids(node, ctx)) : null)
  }

  const columns = (node, ctx) => {
    const ratio = String(node.props.ratio ?? '1:1')
    const [left, right] = ratio.split(':').map((part) => Number(part) || 1)
    return h('div', {
      key: node.id,
      className: 'iui-node',
      style: { display: 'grid', gridTemplateColumns: `minmax(0, ${left}fr) minmax(0, ${right}fr)`, gap: spaceOf(node.props.gap) ?? '12px', minWidth: 0 },
    }, ...kids(node, ctx))
  }

  /* ---- typography ---- */

  const title = (node, ctx) => h('div', {
    key: node.id,
    style: {
      fontSize: SIZE[node.props.size] ?? SIZE.lg,
      fontWeight: WEIGHT.semibold,
      color: toneOf(node.props.tone).fg,
      textAlign: node.props.align,
      lineHeight: 1.3,
      letterSpacing: '-0.01em',
    },
  }, ...kids(node, ctx))

  const bodyText = (node, ctx) => h('div', {
    key: node.id,
    style: {
      fontSize: SIZE[node.props.size] ?? SIZE.md,
      fontWeight: node.props.weight === undefined ? undefined : WEIGHT[node.props.weight],
      color: toneOf(node.props.tone).fg,
      textAlign: node.props.align,
      fontFamily: node.props.mono ? 'var(--ds-font-family-code, ui-monospace, monospace)' : undefined,
      lineHeight: 1.6,
    },
  }, ...kids(node, ctx))

  const bold = (node, ctx) => h('strong', { key: node.id, style: { fontWeight: WEIGHT.semibold, color: node.props.tone === undefined ? undefined : toneOf(node.props.tone).fg } }, ...kids(node, ctx))
  const italic = (node, ctx) => h('em', { key: node.id }, ...kids(node, ctx))
  const code = (node, ctx) => h('code', {
    key: node.id,
    style: {
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
      fontSize: '0.92em',
      padding: '1px 5px',
      borderRadius: RADIUS.sm,
      background: 'var(--dsw-alias-markdown-inline-code, rgba(20,26,40,.06))',
      color: TEXT_PRIMARY,
    },
  }, ...kids(node, ctx))
  // Parsing stays off the page thread. Cancel obsolete work on an edit/unmount;
  // key results to tex/display so a late response never paints an older formula.
  function MathView(props) {
    const display = props.display === true
    const [rendered, setRendered] = React.useState(null)
    React.useEffect(() => {
      const controller = new AbortController()
      let current = true
      renderMathIsolated(props.tex, display, controller.signal).then((result) => {
        if (current) setRendered({ tex: props.tex, display, result })
      })
      return () => { current = false; controller.abort() }
    }, [props.tex, display])
    const result = rendered?.tex === props.tex && rendered?.display === display ? rendered.result : null
    const style = {
      color: props.tone === undefined ? 'inherit' : toneOf(props.tone).fg,
      fontSize: props.size === undefined ? 'inherit' : SIZE[props.size] ?? 'inherit',
      maxWidth: '100%',
      minWidth: display ? 0 : undefined,
      overflowX: display ? 'auto' : undefined,
      marginBlock: display ? spaceOf(2) : undefined,
    }
    if (result === null) {
      return h(display ? 'div' : 'span', {
        className: 'iui-math-pending', 'aria-busy': true, style,
      }, typeof props.tex === 'string' ? props.tex.slice(0, 120) : '[formula]')
    }
    if (result.error !== null) {
      const source = typeof props.tex === 'string' ? props.tex : '[formula]'
      return h(display ? 'div' : 'span', {
        className: 'iui-math-error', role: 'note', title: result.error,
        style: {
          ...style, color: toneOf(props.tone ?? 'error').fg,
          fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        },
      }, source.slice(0, MAX_MATH_LENGTH), source.length > MAX_MATH_LENGTH ? '…' : null)
    }
    return h(display ? 'div' : 'span', {
      className: 'iui-math', style,
      // Only KaTeX's trust:false MathML reaches this sink. Model input is never
      // inserted as markup; every failure takes the escaped text path above.
      dangerouslySetInnerHTML: { __html: result.markup },
    })
  }

  const math = (node) => h(MathView, { ...node.props, key: node.id })

  const caption = (node, ctx) => h('div', { key: node.id, style: { fontSize: SIZE.sm, lineHeight: 1.5, color: toneOf(node.props.tone ?? 'muted').fg } }, ...kids(node, ctx))
  const labelNode = (node, ctx) => h('div', { key: node.id, style: { fontSize: SIZE.sm, fontWeight: WEIGHT.medium, color: TEXT_SECONDARY } }, ...kids(node, ctx))
  const link = (node, ctx) => h('a', {
    key: node.id,
    href: node.props.href,
    target: '_blank',
    rel: 'noreferrer noopener',
    onClick: node.props.onClick,
    style: { color: BRAND, textDecoration: 'none' },
  }, ...kids(node, ctx))
  const kbd = (node, ctx) => h('kbd', {
    key: node.id,
    style: {
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: '0.85em',
      padding: '1px 5px', border: `${HAIRLINE} solid ${BORDER}`, borderBottomWidth: '1.5px',
      borderRadius: RADIUS.sm, background: 'var(--dsw-alias-bg-layer-2, #f5f6f9)', color: TEXT_SECONDARY,
    },
  }, ...kids(node, ctx))
  const quote = (node, ctx) => h('blockquote', {
    key: node.id,
    style: { margin: 0, paddingLeft: '14px', borderLeft: `2px solid ${BORDER}`, color: TEXT_SECONDARY, fontSize: SIZE.md, lineHeight: 1.6 },
  }, ...kids(node, ctx), node.props.cite === undefined ? null : h('div', { key: 'cite', style: { marginTop: '4px', fontSize: SIZE.sm, color: TEXT_TERTIARY } }, `— ${node.props.cite}`))

  const callout = (node, ctx) => {
    const t = toneOf(node.props.tone ?? 'info')
    return h('div', {
      key: node.id,
      style: {
        display: 'flex', gap: '10px', padding: '12px 14px', borderRadius: RADIUS.md,
        background: t.bg === 'transparent' ? 'var(--dsw-alias-bg-layer-2, #f5f6f9)' : t.bg,
        border: `${HAIRLINE} solid ${t.line === 'transparent' ? BORDER : t.line}`,
        minWidth: 0,
      },
    },
      node.props.icon === undefined ? null : h('span', { key: 'icon', style: { color: t.fg, lineHeight: '20px' } }, String(node.props.icon)),
      h('div', { key: 'content', style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0, flex: '1 1 auto' } },
        node.props.title === undefined ? null : h('div', { key: 'title', style: { fontWeight: WEIGHT.semibold, fontSize: SIZE.md, color: t.fg } }, String(node.props.title)),
        h('div', { key: 'body', style: { fontSize: SIZE.md, color: TEXT_PRIMARY, lineHeight: 1.6 } }, ...kids(node, ctx))))
  }

  const list = (node, ctx) => h(node.props.ordered ? 'ol' : 'ul', {
    key: node.id,
    style: {
      margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column',
      gap: spaceOf(node.props.gap) ?? '4px', fontSize: SIZE.md, color: TEXT_PRIMARY, lineHeight: 1.6,
    },
  }, ...kids(node, ctx))
  const item = (node, ctx) => h('li', { key: node.id, style: { paddingLeft: '2px' } },
    node.props.marker === undefined ? null : h('span', { key: 'm', style: { color: TEXT_TERTIARY, marginRight: '6px' } }, String(node.props.marker)),
    ...kids(node, ctx))

  /* ---- controls ---- */

  const slider = (node) => {
    const p = node.props
    const min = Number(p.min ?? 0)
    const max = Number(p.max ?? 100)
    const step = Number(p.step ?? 1) || 1
    const value = Number(p.value ?? min)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      (p.label !== undefined || p.value !== undefined)
        ? h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' } },
            h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, p.label === undefined ? '' : String(p.label)),
            h('span', { key: 'v', style: { fontSize: SIZE.md, fontWeight: WEIGHT.semibold, color: TEXT_PRIMARY } },
              `${formatNumber(value, p.format)}${p.unit === undefined ? '' : String(p.unit)}`))
        : null,
      h('input', {
        key: 'range',
        type: 'range',
        min, max, step, value,
        disabled: Boolean(p.disabled),
        onChange: (event) => { if (typeof p.onChange === 'function') p.onChange(Number(event.target.value)) },
        style: { width: '100%', accentColor: BRAND, cursor: 'pointer' },
      }),
      p.marks ? h('div', { key: 'marks', style: { display: 'flex', justifyContent: 'space-between', fontSize: SIZE.xs, color: TEXT_TERTIARY } },
        h('span', { key: 'min' }, formatNumber(min, p.format)),
        h('span', { key: 'max' }, formatNumber(max, p.format))) : null)
  }

  const switchNode = (node) => {
    const p = node.props
    const on = Boolean(p.checked)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.md, color: TEXT_PRIMARY } }, String(p.label)),
      h('button', {
        key: 'sw',
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        disabled: Boolean(p.disabled),
        onClick: () => { if (typeof p.onChange === 'function') p.onChange(!on) },
        style: {
          appearance: 'none', border: 0, cursor: p.disabled ? 'default' : 'pointer',
          width: '36px', height: '20px', borderRadius: '999px', padding: '2px',
          background: on ? BRAND : 'var(--dsw-alias-border-l3, rgba(20,26,40,.20))',
          display: 'flex', justifyContent: on ? 'flex-end' : 'flex-start',
          transition: 'background .18s ease', flex: '0 0 auto',
        },
      }, h('span', { key: 'thumb', style: { width: '16px', height: '16px', borderRadius: '999px', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.2)' } })))
  }

  const checkbox = (node) => {
    const p = node.props
    const on = Boolean(p.checked)
    return h('label', {
      key: node.id,
      className: 'iui-node',
      style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: p.disabled ? 'default' : 'pointer' },
    },
      h('input', {
        key: 'cb',
        type: 'checkbox',
        checked: on,
        disabled: Boolean(p.disabled),
        onChange: (event) => { if (typeof p.onChange === 'function') p.onChange(event.target.checked) },
        style: { marginTop: '2px', accentColor: BRAND, width: '15px', height: '15px', flex: '0 0 auto' },
      }),
      h('div', { key: 'text', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.md, color: TEXT_PRIMARY } }, String(p.label)),
        p.description === undefined ? null : h('span', { key: 'd', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.description))))
  }

  const radio = (node) => {
    const p = node.props
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      normalizeOptions(p.options).map((option) => h('label', {
        key: String(option.value),
        style: { display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer' },
      },
        h('input', {
          key: 'r', type: 'radio', name: p.name, checked: p.value === option.value,
          onChange: () => { if (typeof p.onChange === 'function') p.onChange(option.value) },
          style: { marginTop: '2px', accentColor: BRAND, flex: '0 0 auto' },
        }),
        h('div', { key: 't', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('span', { key: 'l', style: { fontSize: SIZE.md, color: TEXT_PRIMARY } }, option.label),
          option.description === undefined ? null : h('span', { key: 'd', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, option.description)))))
  }

  const segmented = (node) => {
    const p = node.props
    const options = normalizeOptions(p.options)
    return h('div', {
      key: node.id,
      className: 'iui-node',
      style: {
        display: 'inline-flex', padding: '2px', gap: '2px', borderRadius: RADIUS.md,
        background: 'var(--dsw-alias-bg-layer-3, #eceef4)', alignSelf: 'flex-start', maxWidth: '100%', flexWrap: 'wrap',
      },
    }, options.map((option) => {
      const active = p.value === option.value
      return h('button', {
        key: String(option.value),
        type: 'button',
        onClick: () => { if (typeof p.onChange === 'function') p.onChange(option.value) },
        style: {
          appearance: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit',
          padding: '5px 12px', borderRadius: RADIUS.sm, fontSize: SIZE.sm,
          background: active ? 'var(--dsw-alias-bg-layer-1, #fff)' : 'transparent',
          color: active ? TEXT_PRIMARY : TEXT_SECONDARY,
          fontWeight: active ? WEIGHT.semibold : WEIGHT.regular,
          boxShadow: active ? '0 0 0 0.5px rgba(20,26,40,.10), 0 1px 2px rgba(0,0,0,.05)' : 'none',
          transition: 'background .15s ease',
        },
      }, option.label)
    }))
  }

  const select = (node) => {
    const p = node.props
    const options = normalizeOptions(p.options)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.label)),
      h('select', {
        key: 's',
        value: p.value === undefined ? '' : String(p.value),
        onChange: (event) => {
          const found = options.find((option) => String(option.value) === event.target.value)
          if (typeof p.onChange === 'function') p.onChange(found === undefined ? event.target.value : found.value)
        },
        style: fieldStyle(),
      },
        h('option', { key: '__empty', value: '' }, p.placeholder === undefined ? '—' : String(p.placeholder)),
        options.map((option) => h('option', { key: String(option.value), value: String(option.value) }, option.label))))
  }

  const input = (node) => {
    const p = node.props
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.label)),
      h('input', {
        key: 'i',
        type: 'text',
        value: p.value === undefined ? '' : String(p.value),
        placeholder: p.placeholder,
        disabled: Boolean(p.disabled),
        onChange: (event) => { if (typeof p.onChange === 'function') p.onChange(event.target.value) },
        style: fieldStyle(),
      }))
  }

  /**
   * A text area that fits its content.
   *
   * A fixed height plus a drag handle is the worst of both: the handle is a
   * browser affordance that looks out of place inside a card, and a fixed box
   * either wastes space or hides the text. So the handle is off and the box
   * grows with what is typed, up to a cap after which it scrolls.
   */
  function GrowingTextarea(props) {
    const ref = React.useRef(null)
    const minRows = Math.max(2, Math.min(12, Number(props.minRows ?? 3)))
    const maxRows = Math.max(minRows, Math.min(24, Number(props.maxRows ?? 10)))
    const line = 21

    const fit = React.useCallback(() => {
      const el = ref.current
      if (el === null || el === undefined) return
      el.style.height = 'auto'
      const max = line * maxRows
      const wanted = Math.max(line * minRows, el.scrollHeight)
      el.style.height = `${Math.min(max, wanted)}px`
      el.style.overflowY = wanted > max ? 'auto' : 'hidden'
    }, [minRows, maxRows])

    React.useEffect(fit, [props.value, fit])

    return h('textarea', {
      ref,
      className: 'iui-textarea',
      rows: minRows,
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder,
      disabled: props.disabled === true,
      onChange: (event) => {
        if (typeof props.onValue === 'function') props.onValue(event.target.value)
        // Re-fit on the next frame as well: the value prop may be unchanged when
        // the caller is uncontrolled, and the caret must not jump.
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fit)
      },
      style: { ...fieldStyle(), resize: 'none', lineHeight: `${line}px`, overflowY: 'hidden', ...(props.style ?? {}) },
    })
  }

  const textarea = (node) => {
    const p = node.props
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.label)),
      h(GrowingTextarea, {
        key: 't',
        value: p.value,
        placeholder: p.placeholder,
        minRows: Number(p.rows ?? 3),
        onValue: (next) => { if (typeof p.onChange === 'function') p.onChange(next) },
      }))
  }

  const stepper = (node) => {
    const p = node.props
    const min = p.min === undefined ? -Infinity : Number(p.min)
    const max = p.max === undefined ? Infinity : Number(p.max)
    const step = Number(p.step ?? 1) || 1
    const value = Number(p.value ?? 0)
    const nudge = (delta) => {
      const next = Math.min(max, Math.max(min, value + delta * step))
      if (typeof p.onChange === 'function') p.onChange(next)
    }
    const button = (key, label, delta) => h('button', {
      key, type: 'button', onClick: () => nudge(delta),
      style: {
        appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer',
        width: '28px', height: '28px', borderRadius: RADIUS.sm, color: TEXT_SECONDARY,
        fontSize: '15px', lineHeight: 1, fontFamily: 'inherit',
      },
    }, label)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.label)),
      h('div', { key: 'row', style: { display: 'inline-flex', alignItems: 'center', gap: '2px', border: `${HAIRLINE} solid ${BORDER}`, borderRadius: RADIUS.md, padding: '2px', alignSelf: 'flex-start' } },
        button('down', '−', -1),
        h('span', { key: 'v', style: { minWidth: '44px', textAlign: 'center', fontSize: SIZE.md, fontWeight: WEIGHT.medium, color: TEXT_PRIMARY } }, formatNumber(value)),
        button('up', '+', 1)))
  }

  const rating = (node) => {
    const p = node.props
    const max = Math.max(1, Math.min(10, Number(p.max ?? 5)))
    const value = Number(p.value ?? 0)
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      p.label === undefined ? null : h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.label)),
      h('div', { key: 'stars', style: { display: 'inline-flex', gap: '2px' } },
        Array.from({ length: max }, (_, index) => h('button', {
          key: index,
          type: 'button',
          'aria-label': `${index + 1}`,
          onClick: () => { if (typeof p.onChange === 'function') p.onChange(index + 1) },
          style: {
            appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer',
            padding: 0, fontSize: '16px', lineHeight: 1,
            color: index < value ? 'var(--dsw-alias-state-warn-primary, #e0a300)' : 'var(--dsw-alias-border-l3, rgba(20,26,40,.2))',
          },
        }, '★'))))
  }

  const option = (node) => {
    const p = node.props
    const t = toneOf(p.tone)
    return h('button', {
      key: node.id,
      type: 'button',
      disabled: Boolean(p.disabled),
      onClick: (event) => { if (typeof p.onClick === 'function') p.onClick(p.value, event) },
      style: {
        appearance: 'none', fontFamily: 'inherit', textAlign: 'left', cursor: p.disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'flex-start', gap: '12px', width: '100%',
        padding: '12px 14px', borderRadius: RADIUS.md,
        background: p.selected ? (t.bg === 'transparent' ? 'var(--dsw-alias-bg-layer-2, #f5f6f9)' : t.bg) : 'var(--dsw-alias-bg-layer-1, #ffffff)',
        border: `${p.selected ? '1.5px' : HAIRLINE} solid ${p.selected ? BRAND : BORDER}`,
        transition: 'border-color .15s ease, background .15s ease',
      },
    },
      h('span', { key: 'radio', style: {
        flex: '0 0 auto', width: '16px', height: '16px', marginTop: '1px', borderRadius: '999px',
        border: `1.5px solid ${p.selected ? BRAND : 'var(--dsw-alias-border-l3, rgba(20,26,40,.2))'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      } }, p.selected ? h('span', { key: 'dot', style: { width: '8px', height: '8px', borderRadius: '999px', background: BRAND } }) : null),
      h('span', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
        h('span', { key: 'l', style: { fontSize: SIZE.md, fontWeight: WEIGHT.medium, color: TEXT_PRIMARY } }, p.label === undefined ? '' : String(p.label)),
        p.description === undefined ? null : h('span', { key: 'd', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY, lineHeight: 1.5 } }, String(p.description))),
      p.meta === undefined ? null : h('span', { key: 'meta', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY, flex: '0 0 auto', whiteSpace: 'nowrap' } }, String(p.meta)))
  }

  /** Invisible: it only declares one name/value pair for the card answer. */
  const field = () => null

  const button = (node, ctx) => {
    const p = node.props
    const variant = p.variant ?? 'secondary'
    const palette = {
      primary: { background: 'var(--dsw-alias-button-primary-fill, #2f6bff)', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)', border: 'transparent' },
      secondary: { background: 'var(--dsw-alias-button-elevated-fill, #ffffff)', color: TEXT_PRIMARY, border: BORDER },
      outline: { background: 'transparent', color: TEXT_PRIMARY, border: BORDER },
      ghost: { background: 'transparent', color: TEXT_SECONDARY, border: 'transparent' },
      danger: { background: 'var(--dsw-alias-state-error-primary, #c62828)', color: '#ffffff', border: 'transparent' },
    }[variant] ?? {}
    return h('button', {
      key: node.id,
      type: 'button',
      disabled: Boolean(p.disabled),
      'data-iui-submit': p.submit ? 'true' : undefined,
      onClick: (event) => {
        if (p.disabled) return
        if (typeof p.onClick === 'function') p.onClick(p.action, event)
      },
      style: {
        appearance: 'none', fontFamily: 'inherit', fontSize: SIZE.md, fontWeight: WEIGHT.medium,
        padding: '7px 14px', borderRadius: RADIUS.sm, cursor: p.disabled ? 'default' : 'pointer',
        opacity: p.disabled ? 0.5 : 1, lineHeight: 1.4, whiteSpace: 'nowrap',
        transition: 'filter .15s ease',
        ...palette,
        border: `${HAIRLINE} solid ${palette.border ?? 'transparent'}`,
      },
    }, p.label === undefined ? '' : String(p.label), ...kids(node, ctx))
  }

  const actions = (node, ctx) => h('div', {
    key: node.id,
    style: {
      display: 'flex', gap: spaceOf(node.props.gap) ?? '8px', flexWrap: 'wrap',
      justifyContent: justifyValue(node.props.align) ?? 'flex-end',
    },
  }, ...kids(node, ctx))

  const form = (node, ctx) => {
    const p = node.props
    return h('form', {
      key: node.id,
      className: 'iui-node',
      onSubmit: (event) => { event.preventDefault(); if (typeof p.onSubmit === 'function') p.onSubmit() },
      style: { display: 'flex', flexDirection: 'column', gap: spaceOf(p.gap) ?? '12px', padding: spaceOf(p.padding) },
    }, ...kids(node, ctx),
      p.submitLabel === undefined ? null : h('div', { key: 'submit', style: { display: 'flex', justifyContent: 'flex-end' } },
        h('button', { key: 'b', type: 'submit', 'data-iui-submit': 'true', style: { appearance: 'none', border: 'none', fontFamily: 'inherit', fontSize: SIZE.md, padding: '7px 14px', borderRadius: RADIUS.sm, background: BRAND, color: '#fff', cursor: 'pointer' } }, String(p.submitLabel))))
  }

  /* ---- data display ---- */

  const table = (node) => {
    const p = node.props
    const rawColumns = Array.isArray(p.columns) ? p.columns : []
    const columnsList = rawColumns.map((column) => (
      column !== null && typeof column === 'object'
        ? { key: column.key ?? column.label, label: String(column.label ?? column.key ?? ''), align: column.align }
        : { key: String(column), label: String(column), align: undefined }
    ))
    const rows = Array.isArray(p.rows) ? p.rows : []
    const cell = (row, column, index) => {
      const value = Array.isArray(row) ? row[index] : row?.[column.key]
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
    }
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h('div', { key: 'wrap', style: { overflowX: 'auto', border: `${HAIRLINE} solid ${BORDER}`, borderRadius: RADIUS.md, minWidth: 0 } },
        h('table', { key: 't', style: { width: '100%', borderCollapse: 'collapse', fontSize: SIZE.md, color: TEXT_PRIMARY } },
          h('thead', { key: 'h' }, h('tr', { key: 'hr' }, columnsList.map((column) => h('th', {
            key: column.key,
            style: {
              textAlign: column.align ?? (Array.isArray(rows[0]) ? 'left' : 'left'),
              padding: p.compact ? '6px 10px' : '9px 12px',
              fontSize: SIZE.sm, fontWeight: WEIGHT.semibold, color: TEXT_SECONDARY,
              borderBottom: `${HAIRLINE} solid ${BORDER}`, whiteSpace: 'nowrap',
              background: 'var(--dsw-alias-bg-layer-2, #f5f6f9)',
            },
          }, column.label)))),
          h('tbody', { key: 'b' }, rows.map((row, rowIndex) => h('tr', {
            key: rowIndex,
            style: { background: p.striped && rowIndex % 2 === 1 ? 'var(--dsw-alias-bg-layer-2, #f5f6f9)' : 'transparent' },
          }, columnsList.map((column, columnIndex) => h('td', {
            key: `${column.key}-${columnIndex}`,
            style: {
              textAlign: column.align ?? 'left',
              padding: p.compact ? '6px 10px' : '9px 12px',
              borderBottom: rowIndex === rows.length - 1 ? 'none' : `${HAIRLINE} solid ${BORDER}`,
              verticalAlign: 'top',
            },
          }, cell(row, column, columnIndex)))))))),
      p.caption === undefined ? null : h('div', { key: 'cap', style: { fontSize: SIZE.sm, color: TEXT_TERTIARY } }, String(p.caption)))
  }

  const kv = (node) => {
    const items = Array.isArray(node.props.items) ? node.props.items : []
    const columns = Math.max(1, Math.min(3, Number(node.props.columns ?? 1)))
    return h('div', {
      key: node.id,
      style: { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '10px 20px', minWidth: 0 },
    }, items.map((entry, index) => h('div', { key: index, style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
      h('span', { key: 'k', style: { fontSize: SIZE.sm, color: TEXT_TERTIARY } }, String(entry?.label ?? '')),
      h('span', { key: 'v', style: { fontSize: SIZE.md, color: toneOf(entry?.tone).fg, fontWeight: WEIGHT.medium } },
        entry?.value === null || entry?.value === undefined ? '—' : String(entry.value)))))
  }

  const stat = (node) => {
    const p = node.props
    const t = toneOf(p.tone)
    const trendColor = p.trend === 'up'
      ? 'var(--dsw-alias-state-success-primary, #12854a)'
      : p.trend === 'down'
        ? 'var(--dsw-alias-state-error-primary, #c62828)'
        : TEXT_TERTIARY
    return h('div', {
      key: node.id,
      className: 'iui-node',
      style: {
        display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 14px',
        borderRadius: RADIUS.md, background: 'var(--dsw-alias-bg-layer-2, #f5f6f9)',
        border: `${HAIRLINE} solid ${BORDER}`, minWidth: 0,
      },
    },
      h('span', { key: 'l', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, p.label === undefined ? '' : String(p.label)),
      h('div', { key: 'v', style: { display: 'flex', alignItems: 'baseline', gap: '5px', flexWrap: 'wrap' } },
        h('span', { key: 'n', style: { fontSize: SIZE.xl, fontWeight: WEIGHT.semibold, color: t.fg, letterSpacing: '-0.02em' } },
          typeof p.value === 'number' ? formatNumber(p.value) : String(p.value ?? '')),
        p.unit === undefined ? null : h('span', { key: 'u', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(p.unit))),
      p.delta === undefined ? null : h('span', { key: 'd', style: { fontSize: SIZE.sm, color: trendColor } }, String(p.delta)),
      p.help === undefined ? null : h('span', { key: 'h', style: { fontSize: SIZE.xs, color: TEXT_TERTIARY } }, String(p.help)))
  }

  const progress = (node) => {
    const p = node.props
    const max = Number(p.max ?? 100) || 100
    const value = Number(p.value ?? 0)
    const percent = Math.max(0, Math.min(100, (value / max) * 100))
    const t = toneOf(p.tone ?? 'brand')
    return h('div', { key: node.id, className: 'iui-node', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      (p.label !== undefined || p.showValue)
        ? h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', fontSize: SIZE.sm, color: TEXT_SECONDARY } },
            h('span', { key: 'l' }, p.label === undefined ? '' : String(p.label)),
            p.showValue ? h('span', { key: 'v' }, `${Math.round(percent)}%`) : null)
        : null,
      h('div', { key: 'track', style: { height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-3, #eceef4)', overflow: 'hidden' } },
        h('div', { key: 'fill', style: { width: `${percent}%`, height: '100%', background: t.fg, borderRadius: '999px', transition: 'width .42s cubic-bezier(.4,0,.2,1)' } })))
  }

  const badge = (node, ctx) => {
    const p = node.props
    const t = toneOf(p.tone ?? 'neutral')
    const variant = p.variant ?? 'soft'
    const style = variant === 'solid'
      ? { background: t.fg, color: '#fff', border: 'transparent' }
      : variant === 'outline'
        ? { background: 'transparent', color: t.fg, border: t.line === 'transparent' ? BORDER : t.line }
        : { background: t.bg === 'transparent' ? 'var(--dsw-alias-bg-layer-3, #eceef4)' : t.bg, color: t.fg, border: 'transparent' }
    return h('span', {
      key: node.id,
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', alignSelf: 'flex-start',
        padding: '2px 8px', borderRadius: '999px', fontSize: SIZE.xs, fontWeight: WEIGHT.medium,
        lineHeight: 1.6, ...style, border: `${HAIRLINE} solid ${style.border}`,
      },
    }, p.dot ? h('span', { key: 'dot', style: { width: '5px', height: '5px', borderRadius: '999px', background: 'currentColor' } }) : null, ...kids(node, ctx))
  }

  const pill = (node, ctx) => h('span', {
    key: node.id,
    style: {
      display: 'inline-flex', alignItems: 'center', alignSelf: 'flex-start',
      padding: '2px 9px', borderRadius: '999px', fontSize: SIZE.sm, lineHeight: 1.6,
      background: 'var(--dsw-alias-bg-layer-3, #eceef4)', color: toneOf(node.props.tone).fg,
    },
  }, ...kids(node, ctx))

  const avatar = (node) => {
    const p = node.props
    const size = { sm: 24, md: 32, lg: 44 }[p.size] ?? 32
    const initial = String(p.name ?? '?').trim().slice(0, 1).toUpperCase()
    return h('span', {
      key: node.id,
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: `${size}px`, height: `${size}px`, borderRadius: '999px', overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-3, #eceef4)', color: TEXT_SECONDARY,
        fontSize: `${Math.round(size * 0.42)}px`, fontWeight: WEIGHT.semibold, flex: '0 0 auto',
      },
    }, p.src ? h('img', { key: 'img', src: p.src, alt: p.name ?? '', style: { width: '100%', height: '100%', objectFit: 'cover' } }) : initial)
  }

  const image = (node) => {
    const p = node.props
    const ratio = { '1:1': '1 / 1', '4:3': '4 / 3', '16:9': '16 / 9', '3:2': '3 / 2' }[p.ratio]
    return h('figure', { key: node.id, style: { margin: 0, display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h('img', {
        key: 'img', src: p.src, alt: p.alt ?? '', loading: 'lazy',
        style: {
          width: '100%', display: 'block', objectFit: 'cover',
          aspectRatio: ratio, borderRadius: radiusOf(p.radius) ?? RADIUS.md,
          background: 'var(--dsw-alias-bg-skeleton, #f0f1f5)',
        },
      }),
      p.caption === undefined ? null : h('figcaption', { key: 'cap', style: { fontSize: SIZE.sm, color: TEXT_TERTIARY } }, String(p.caption)))
  }

  const gallery = (node) => {
    const p = node.props
    const items = Array.isArray(p.items) ? p.items : []
    const columns = Math.max(1, Math.min(4, Number(p.columns ?? 2)))
    const ratio = { '1:1': '1 / 1', '4:3': '4 / 3', '16:9': '16 / 9' }[p.ratio] ?? '1 / 1'
    return h('div', { key: node.id, style: { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: '8px', minWidth: 0 } },
      items.map((entry, index) => h('img', {
        key: index, src: entry?.src, alt: entry?.alt ?? '', loading: 'lazy',
        title: entry?.caption,
        style: { width: '100%', display: 'block', objectFit: 'cover', aspectRatio: ratio, borderRadius: RADIUS.sm, background: 'var(--dsw-alias-bg-skeleton, #f0f1f5)' },
      })))
  }

  const ICONS = {
    check: 'M4 12l5 5L20 6',
    close: 'M6 6l12 12M18 6L6 18',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    warning: 'M12 3l9 17H3zM12 9v5M12 17h.01',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    star: 'M12 3l2.9 6.2 6.6.9-4.8 4.7 1.2 6.6L12 18.3 6.1 21.4l1.2-6.6L2.5 10l6.6-.9z',
    heart: 'M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.6 12 20 12 20z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
    chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2',
    bolt: 'M13 2L4 14h6l-1 8 9-12h-6z',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18',
    lock: 'M6 11V8a6 6 0 1 1 12 0v3M5 11h14v10H5z',
  }

  const icon = (node) => {
    const p = node.props
    const path = ICONS[String(p.name ?? '')] ?? ICONS.sparkle
    const px = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, '2xl': 30, '3xl': 38 }[p.size] ?? 16
    return h('svg', {
      key: node.id, width: px, height: px, viewBox: '0 0 24 24', fill: 'none',
      stroke: toneOf(p.tone).fg, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { flex: '0 0 auto' }, 'aria-hidden': 'true',
    }, h('path', { key: 'p', d: path }))
  }

  const chart = (node) => {
    const height = Math.max(60, Math.min(420, Number(node.props.height ?? 220)))
    // No chart runtime in this build: draw the inline SVG instead of nothing.
    if (!HAS_CHARTS) return renderChart(h, node)
    // The option is built *inside* ChartHost rather than here, because it
    // depends on the live theme, and a renderer is a plain function called
    // during its parent's render — it may not own hooks of its own.
    return h(ChartHost, {
      key: node.id,
      props: node.props,
      height,
      fallback: () => renderChart(h, node),
    })
  }
  const sparkline = (node) => renderSparkline(h, node)

  const timeline = (node) => {
    const items = Array.isArray(node.props.items) ? node.props.items : []
    return h('div', { key: node.id, style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
      items.map((entry, index) => h('div', { key: index, style: { display: 'flex', gap: '12px', minWidth: 0 } },
        h('div', { key: 'rail', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: '0 0 auto', paddingTop: '4px' } },
          h('span', { key: 'dot', style: { width: '9px', height: '9px', borderRadius: '999px', background: toneOf(entry?.tone ?? 'brand').fg, flex: '0 0 auto' } }),
          index === items.length - 1 ? null : h('span', { key: 'line', style: { flex: '1 1 auto', width: HAIRLINE, background: BORDER, minHeight: '14px', marginTop: '3px' } })),
        h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: '2px', paddingBottom: index === items.length - 1 ? 0 : '14px', minWidth: 0 } },
          h('div', { key: 'head', style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { key: 't', style: { fontSize: SIZE.md, fontWeight: WEIGHT.medium, color: TEXT_PRIMARY } }, String(entry?.title ?? '')),
            entry?.time === undefined ? null : h('span', { key: 'time', style: { fontSize: SIZE.xs, color: TEXT_TERTIARY } }, String(entry.time))),
          entry?.body === undefined ? null : h('span', { key: 'body', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY, lineHeight: 1.55 } }, String(entry.body))))))
  }

  const steps = (node) => {
    const items = Array.isArray(node.props.steps) ? node.props.steps : []
    const current = Number(node.props.current ?? -1)
    return h('ol', { key: node.id, style: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '10px' } },
      items.map((entry, index) => {
        const done = entry?.done === true || (current >= 0 && index < current)
        const active = index === current
        return h('li', { key: index, style: { display: 'flex', gap: '10px', minWidth: 0 } },
          h('span', { key: 'n', style: {
            flex: '0 0 auto', width: '20px', height: '20px', borderRadius: '999px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: SIZE.xs, fontWeight: WEIGHT.semibold,
            background: done || active ? BRAND : 'var(--dsw-alias-bg-layer-3, #eceef4)',
            color: done || active ? '#fff' : TEXT_TERTIARY,
          } }, done ? '✓' : String(index + 1)),
          h('div', { key: 'b', style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
            h('span', { key: 't', style: { fontSize: SIZE.md, color: TEXT_PRIMARY, fontWeight: active ? WEIGHT.semibold : WEIGHT.regular } }, String(entry?.title ?? '')),
            entry?.body === undefined ? null : h('span', { key: 'd', style: { fontSize: SIZE.sm, color: TEXT_SECONDARY } }, String(entry.body))))
      }))
  }

  const codeblock = (node) => {
    const p = node.props
    return h('div', { key: node.id, style: { borderRadius: RADIUS.md, overflow: 'hidden', border: `${HAIRLINE} solid ${BORDER}`, minWidth: 0 } },
      p.filename === undefined && p.language === undefined ? null : h('div', { key: 'head', style: {
        display: 'flex', justifyContent: 'space-between', gap: '8px',
        padding: '6px 12px', fontSize: SIZE.xs, color: TEXT_TERTIARY,
        background: 'var(--dsw-alias-bg-layer-3, #eceef4)',
      } }, h('span', { key: 'f' }, String(p.filename ?? '')), h('span', { key: 'l' }, String(p.language ?? ''))),
      h('pre', { key: 'pre', style: {
        margin: 0, padding: '12px 14px', overflowX: 'auto',
        background: 'var(--dsw-alias-markdown-code-block, #f7f8fa)',
        fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
        fontSize: SIZE.sm, lineHeight: 1.6, color: TEXT_PRIMARY,
        whiteSpace: p.wrap ? 'pre-wrap' : 'pre',
      } }, node.children.map((child) => (child.type === '#text' ? child.text : '')).join('')))
  }

  const json = (node) => h('pre', {
    key: node.id,
    style: {
      margin: 0, padding: '12px 14px', overflowX: 'auto', borderRadius: RADIUS.md,
      border: `${HAIRLINE} solid ${BORDER}`, background: 'var(--dsw-alias-markdown-code-block, #f7f8fa)',
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: SIZE.sm,
      lineHeight: 1.55, color: TEXT_PRIMARY,
    },
  }, safeJson(node.props.value))

  const renderUnknown = (node) => h('div', {
    key: node.id,
    style: {
      padding: '8px 12px', borderRadius: RADIUS.sm, fontSize: SIZE.sm,
      border: `1px dashed var(--dsw-alias-border-l3, rgba(20,26,40,.2))`,
      color: TEXT_TERTIARY, fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
    },
  }, `<${node.type}>`)

  const renderError = (node) => h('div', {
    key: node.id,
    style: {
      display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 12px',
      borderRadius: RADIUS.sm, fontSize: SIZE.sm,
      background: toneOf('error').bg, border: `${HAIRLINE} solid ${toneOf('error').line}`, color: toneOf('error').fg,
    },
  }, h('span', { key: 'i' }, '⚠'), h('span', { key: 'm', style: { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)' } },
    node.props.component === undefined ? String(node.props.message ?? 'render error') : `<${node.props.component}>: ${node.props.message}`))

  /**
   * One live ECharts instance.
   *
   * Three things have to be right and are easy to get wrong: the instance is
   * created once per mount and disposed on unmount; the option is applied only
   * when it actually changed; and the canvas follows the container's width. A
   * chart that throws falls back to the inline SVG drawing rather than taking
   * the card down with it.
   */
  function ChartHost(props) {
    const theme = useThemeKey()
    const hostRef = React.useRef(null)
    const instanceRef = React.useRef(null)
    const [failed, setFailed] = React.useState(false)
    // Two values, for two different jobs.
    //
    // `dep` decides *whether* to re-apply the option: the props came over the
    // operation wire as JSON, so their serialization is a faithful change key,
    // and it stays stable across a re-render that changed nothing.
    //
    // `option` is the real object, which deliberately carries formatter
    // *functions*. Serializing it would silently drop every number format.
    const chartProps = props.props
    const dep = React.useMemo(() => JSON.stringify(chartProps), [chartProps])
    const option = React.useMemo(() => buildChartOption(chartProps, chartTokens()), [dep, theme])

    React.useEffect(() => {
      const container = hostRef.current
      if (container === null || failed) return undefined
      const echarts = chartRuntime()
      if (echarts === null || typeof echarts.init !== 'function') {
        setFailed(true)
        return undefined
      }
      let instance
      try {
        instance = echarts.init(container, null, { renderer: 'canvas' })
      } catch {
        setFailed(true)
        return undefined
      }
      instanceRef.current = instance
      let observer = null
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(() => { try { instance.resize() } catch { /* disposed */ } })
        observer.observe(container)
      }
      return () => {
        if (observer !== null) observer.disconnect()
        instanceRef.current = null
        try { instance.dispose() } catch { /* already gone */ }
      }
    }, [failed, theme])

    React.useEffect(() => {
      const instance = instanceRef.current
      if (instance === null || instance === undefined || failed) return
      try {
        instance.setOption(option, true)
      } catch {
        setFailed(true)
      }
    }, [option, theme, failed])

    if (failed) return props.fallback()
    return h('div', {
      ref: hostRef,
      className: 'iui-chart',
      style: { width: '100%', height: `${props.height}px` },
    })
  }

  const COMPONENTS = {
    box, row, grid, card, divider, spacer, scroll, tabs, tab, reveal, columns,
    title, text: bodyText, bold, italic, code, math, caption, label: labelNode, link, kbd, quote, callout, list, item,
    slider, switch: switchNode, checkbox, radio, segmented, select, input, textarea, stepper, rating, option, field, button, actions, form,
    table, kv, stat, progress, badge, pill, avatar, image, gallery, icon, chart, sparkline, timeline, steps, codeblock, json,
  }

  /** Render one decoded node. */
  function renderNode(node, ctx) {
    if (node === null || node === undefined) return null
    if (node.type === '#text') return node.text
    if (node.type === '#fragment' || node.type === '#root') {
      return h(Fragment, { key: node.id }, ...node.children.map((child) => renderNode(child, ctx)))
    }
    if (node.type === '#error') return renderError(node)
    if (node.type === '#unsupported') return renderUnknown({ ...node, type: String(node.props.why ?? 'unknown') })
    const renderer = COMPONENTS[node.type]
    if (renderer === undefined) return renderUnknown(node)
    const scope = ctx ?? { render: (child) => renderNode(child, ctx) }
    return renderer(node, scope)
  }

  return { renderNode, COMPONENTS, GrowingTextarea }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function fieldStyle() {
  return {
    // `border-box` matters here: a text control that overflows its container by
    // its own padding is the classic source of a card that scrolls sideways.
    width: '100%', boxSizing: 'border-box', padding: '7px 10px',
    borderRadius: RADIUS.sm, border: `${HAIRLINE} solid ${BORDER}`,
    background: 'var(--dsw-alias-bg-layer-1, #ffffff)', color: TEXT_PRIMARY,
    fontSize: SIZE.md, fontFamily: 'inherit', outline: 'none',
  }
}

function alignValue(align) {
  switch (align) {
    case 'start': return 'flex-start'
    case 'center': return 'center'
    case 'end': return 'flex-end'
    case 'stretch': return 'stretch'
    case 'baseline': return 'baseline'
    default: return undefined
  }
}

function justifyValue(justify) {
  switch (justify) {
    case 'start': return 'flex-start'
    case 'center': return 'center'
    case 'end': return 'flex-end'
    case 'between': return 'space-between'
    case 'around': return 'space-around'
    default: return undefined
  }
}

function widthValue(width) {
  switch (width) {
    case 'full': return '100%'
    case 'half': return '50%'
    case 'third': return '33.333%'
    case 'twothirds': return '66.666%'
    default: return undefined
  }
}

/** The single raw-CSS escape hatch the catalog allows. */
function rawCss(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const out = {}
  for (const declaration of value.split(';')) {
    const at = declaration.indexOf(':')
    if (at === -1) continue
    const property = declaration.slice(0, at).trim()
    const text = declaration.slice(at + 1).trim()
    if (property === '') continue
    out[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = text
  }
  return out
}

function merge(base, extra) {
  return extra === null ? base : { ...base, ...extra }
}

function safeJson(value) {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

/* ------------------------------------------------------------------ *
 * Charts — drawn, not fetched
 * ------------------------------------------------------------------ */

const CHART_TONES = ['var(--dsw-alias-state-business-primary, #2f6bff)', 'var(--dsw-alias-state-success-primary, #12854a)', 'var(--dsw-alias-state-warn-primary, #b06a00)', 'var(--dsw-alias-state-error-primary, #c62828)', 'var(--dsw-alias-state-idle-primary, #3b6fd4)']

function seriesPoints(series) {
  const data = Array.isArray(series?.data) ? series.data : []
  return data.map((entry, index) => (
    entry !== null && typeof entry === 'object'
      ? { x: Number(entry.x ?? index), y: Number(entry.y ?? 0) }
      : { x: index, y: Number(entry) || 0 }
  ))
}

function renderChart(h, node) {
  const p = node.props
  const series = (Array.isArray(p.series) ? p.series : []).map((entry) => ({
    name: entry?.name ?? '',
    tone: entry?.tone,
    points: seriesPoints(entry),
  }))
  const width = 560
  const height = Math.max(60, Math.min(420, Number(p.height ?? 180)))
  const padding = { top: 12, right: 12, bottom: 26, left: 40 }
  const all = series.flatMap((entry) => entry.points)
  if (all.length === 0) return h('div', { key: node.id, style: { fontSize: SIZE.sm, color: TEXT_TERTIARY } }, 'No data')

  const colorOf = (index, entry) => (entry.tone === undefined ? CHART_TONES[index % CHART_TONES.length] : toneOf(entry.tone).fg)
  const type = p.type ?? 'bar'
  const body = []

  if (type === 'pie' || type === 'donut') {
    const values = series[0].points.map((point) => Math.max(0, point.y))
    const total = values.reduce((sum, value) => sum + value, 0) || 1
    const radiusPx = Math.min(width, height) / 2 - 8
    const cx = width / 2
    const cy = height / 2
    let angle = -Math.PI / 2
    values.forEach((value, index) => {
      const sweep = (value / total) * Math.PI * 2
      const x1 = cx + radiusPx * Math.cos(angle)
      const y1 = cy + radiusPx * Math.sin(angle)
      angle += sweep
      const x2 = cx + radiusPx * Math.cos(angle)
      const y2 = cy + radiusPx * Math.sin(angle)
      const large = sweep > Math.PI ? 1 : 0
      const inner = type === 'donut' ? radiusPx * 0.58 : 0
      const d = inner === 0
        ? `M ${cx} ${cy} L ${x1} ${y1} A ${radiusPx} ${radiusPx} 0 ${large} 1 ${x2} ${y2} Z`
        : `M ${cx + inner * Math.cos(angle - sweep)} ${cy + inner * Math.sin(angle - sweep)} L ${x1} ${y1} A ${radiusPx} ${radiusPx} 0 ${large} 1 ${x2} ${y2} L ${cx + inner * Math.cos(angle)} ${cy + inner * Math.sin(angle)} A ${inner} ${inner} 0 ${large} 0 ${cx + inner * Math.cos(angle - sweep)} ${cy + inner * Math.sin(angle - sweep)} Z`
      body.push(h('path', { key: index, d, fill: CHART_TONES[index % CHART_TONES.length], stroke: 'none' }))
    })
  } else {
    const xs = all.map((point) => point.x)
    const ys = all.map((point) => point.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(0, ...ys)
    const maxY = Math.max(...ys, 1)
    const plotWidth = width - padding.left - padding.right
    const plotHeight = height - padding.top - padding.bottom
    const sx = (x) => padding.left + ((x - minX) / (maxX - minX || 1)) * plotWidth
    const sy = (y) => padding.top + plotHeight - ((y - minY) / (maxY - minY || 1)) * plotHeight

    for (let tick = 0; tick <= 4; tick += 1) {
      const y = padding.top + (plotHeight * tick) / 4
      const value = maxY - ((maxY - minY) * tick) / 4
      body.push(h('line', { key: `g${tick}`, x1: padding.left, x2: width - padding.right, y1: y, y2: y, stroke: 'var(--dsw-alias-border-l1, rgba(20,26,40,.06))', strokeWidth: 1 }))
      body.push(h('text', { key: `t${tick}`, x: padding.left - 6, y: y + 3, textAnchor: 'end', fontSize: 9, fill: TEXT_TERTIARY },
        formatNumber(Number(value.toFixed(2)), p.valueFormat)))
    }

    if (type === 'bar') {
      const groupWidth = plotWidth / Math.max(1, series[0].points.length)
      const barWidth = Math.max(2, (groupWidth * 0.6) / series.length)
      series.forEach((entry, seriesIndex) => {
        entry.points.forEach((point, index) => {
          const x = padding.left + groupWidth * index + groupWidth * 0.2 + barWidth * seriesIndex
          const y = sy(Math.max(0, point.y))
          const zero = sy(Math.max(0, minY))
          body.push(h('rect', {
            key: `b${seriesIndex}-${index}`,
            x, y, width: barWidth, height: Math.max(1, zero - y),
            rx: 2, fill: colorOf(seriesIndex, entry),
          }))
        })
      })
    } else {
      series.forEach((entry, seriesIndex) => {
        const color = colorOf(seriesIndex, entry)
        const path = entry.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${sx(point.x)} ${sy(point.y)}`).join(' ')
        if (type === 'area') {
          body.push(h('path', {
            key: `a${seriesIndex}`,
            d: `${path} L ${sx(entry.points[entry.points.length - 1].x)} ${sy(Math.max(0, minY))} L ${sx(entry.points[0].x)} ${sy(Math.max(0, minY))} Z`,
            fill: color, opacity: 0.16, stroke: 'none',
          }))
        }
        body.push(h('path', { key: `p${seriesIndex}`, d: path, fill: 'none', stroke: color, strokeWidth: type === 'scatter' ? 0 : 2, strokeLinecap: 'round', strokeLinejoin: 'round' }))
        if (type === 'scatter') {
          entry.points.forEach((point, index) => body.push(h('circle', { key: `c${seriesIndex}-${index}`, cx: sx(point.x), cy: sy(point.y), r: 3, fill: color })))
        }
      })
    }

    if (Array.isArray(p.categories)) {
      const categories = p.categories
      const step = plotWidth / Math.max(1, categories.length - 1)
      categories.forEach((category, index) => {
        body.push(h('text', {
          key: `x${index}`, x: padding.left + step * index, y: height - 8,
          textAnchor: 'middle', fontSize: 9, fill: TEXT_TERTIARY,
        }, String(category)))
      })
    }
  }

  return h('div', { key: node.id, style: { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 } },
    h('svg', {
      key: 'svg', viewBox: `0 0 ${width} ${height}`, width: '100%', height,
      style: { display: 'block', overflow: 'visible' }, role: 'img',
    }, ...body),
    p.legend
      ? h('div', { key: 'legend', style: { display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: SIZE.xs, color: TEXT_SECONDARY } },
          series.map((entry, index) => h('span', { key: index, style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
            h('span', { key: 'sw', style: { width: '9px', height: '9px', borderRadius: '2px', background: colorOf(index, entry) } }),
            entry.name)))
      : null)
}

function renderSparkline(h, node) {
  const p = node.props
  const points = seriesPoints({ data: p.data })
  const width = 120
  const height = Math.max(16, Math.min(80, Number(p.height ?? 28)))
  if (points.length < 2) return h('div', { key: node.id, style: { height: `${height}px` } })
  const ys = points.map((point) => point.y)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const pad = 3
  const sx = (index) => (index / (points.length - 1)) * (width - pad * 2) + pad
  const sy = (value) => height - pad - ((value - minY) / (maxY - minY || 1)) * (height - pad * 2)
  const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${sx(index).toFixed(2)} ${sy(point.y).toFixed(2)}`).join(' ')
  const resolved = toneOf(p.tone).fg
  const color = resolved === TONE_MAP.neutral.fg ? BRAND : resolved
  const lastIndex = points.length - 1
  return h('svg', {
    key: node.id, viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    preserveAspectRatio: 'none', style: { display: 'block', overflow: 'visible' },
  },
    p.area === true
      ? h('path', {
          key: 'area',
          d: `${d} L ${sx(lastIndex).toFixed(2)} ${height} L ${sx(0).toFixed(2)} ${height} Z`,
          fill: color, opacity: 0.14, stroke: 'none',
        })
      : null,
    h('path', { key: 'p', d, fill: 'none', stroke: color, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    p.last === true
      ? h('circle', { key: 'last', cx: sx(lastIndex), cy: sy(points[lastIndex].y), r: 2.4, fill: color })
      : null)
}
