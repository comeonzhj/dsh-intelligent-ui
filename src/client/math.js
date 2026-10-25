/**
 * LaTeX → native MathML. In production this kernel runs only in the dedicated
 * formula Worker, never on the page or in the DIL execution sandbox. The engine
 * is injected from the pinned local vendor; no CSS, fonts or network are needed.
 */

export const MAX_MATH_LENGTH = 8192
export const MAX_MATH_MARKUP_LENGTH = 65536
export const MAX_MATH_ELEMENTS = 2048

/** Cheap preflight shared by the page scheduler and the isolated kernel. */
export function mathInputError(tex) {
  if (typeof tex !== 'string') return 'Expected a LaTeX string in tex.'
  if (tex.length > MAX_MATH_LENGTH) return `LaTeX exceeds ${MAX_MATH_LENGTH} characters.`
  return null
}

// Physical units use a nominal 16px/em reference. ex is conservatively
// bounded as one em; relative units must include the cumulative mathsize scale.
const MATH_LENGTH_UNITS = {
  em: 1, ex: 1, '%': 1 / 100,
  px: 1 / 16, pt: 1 / 12, bp: 1 / 12, pc: 1, in: 6,
  cm: 6 / 2.54, mm: 6 / 25.4, dd: 1238 / 1157 / 12,
  cc: 1238 / 1157, nd: 685 / 642 / 12, nc: 685 / 642,
  sp: 1 / (65536 * 12), mu: 1 / 18,
}

function mathLength(value, scale) {
  const match = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*([a-z]+|%)?$/i.exec(value)
  if (match === null) return null
  const unit = (match[2] ?? 'em').toLowerCase()
  const factor = MATH_LENGTH_UNITS[unit]
  if (factor === undefined) return null
  const relative = unit === 'em' || unit === 'ex' || unit === '%' || unit === 'mu'
  const size = Number(match[1]) * factor * (relative ? scale : 1)
  return Number.isFinite(size) ? size : null
}

/** Check only pinned-library output, not an arbitrary HTML sanitization API. */
export function mathMarkupError(markup) {
  if (typeof markup !== 'string' || markup.length > MAX_MATH_MARKUP_LENGTH) return 'Formula output is too large.'
  const sizes = [1]
  let elements = 0
  // Pinned KaTeX escapes annotation/text contents. Only actual generated tags
  // enter this scan; raw TeX in the annotation must not be treated as layout.
  for (const [tag, closing] of markup.matchAll(/<(\/?)[a-z][a-z0-9-]*\b[^>]*>/gi)) {
    if (closing === '/') { if (sizes.length > 1) sizes.pop(); continue }
    if (++elements > MAX_MATH_ELEMENTS) return 'Formula has too many elements.'
    const inherited = sizes[sizes.length - 1]
    const font = /\bmathsize="([^"]*)"/.exec(tag)
    const scale = font === null ? inherited : mathLength(font[1], inherited)
    if (scale === null || scale < 0 || scale > 10) return 'Formula layout exceeds the size limit.'
    const dimensions = /\b(width|height|depth|voffset|lspace|rspace|minsize|maxsize|linethickness|columnspacing|rowspacing|framespacing|scriptminsize)="([^"]*)"/g
    for (const [, name, value] of tag.matchAll(dimensions)) {
      // Fixed relative/automatic values emitted by KaTeX for laps and tables.
      // A maxsize sentinel does not itself impose an infinite physical size.
      if ((name === 'maxsize' && value === 'infinity') || (name === 'width' && value === 'auto')) continue
      for (const length of value.trim().split(/\s+/)) {
        if ((name === 'lspace' || name === 'width') && /^(?:-?1|-?0\.5|0)width$/.test(length)) continue
        const size = mathLength(length, scale)
        if (size === null || Math.abs(size) > 10) return 'Formula layout exceeds the size limit.'
      }
    }
    if (!tag.endsWith('/>')) sizes.push(scale)
  }
  return null
}

/** Return trusted-library markup or a local error; callers supply the engine. */
export function renderMath(tex, display = false, runtime = null) {
  const inputError = mathInputError(tex)
  if (inputError !== null) return { markup: null, error: inputError }
  if (tex.trim() === '') return { markup: '', error: null }
  if (typeof runtime?.renderToString !== 'function') {
    return { markup: null, error: 'The formula renderer is unavailable.' }
  }
  try {
    const markup = runtime.renderToString(tex, {
      output: 'mathml',
      displayMode: display === true,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 10,
      // KaTeX can mutate this object through \\gdef. Never share it across cards.
      macros: {},
    })
    const error = mathMarkupError(markup)
    return error === null ? { markup, error: null } : { markup: null, error }
  } catch (error) {
    return { markup: null, error: String(error?.message ?? 'Invalid LaTeX.').slice(0, 240) }
  }
}
