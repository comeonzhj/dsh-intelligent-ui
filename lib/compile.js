/**
 * Intelligent UI — the DIL compiler.
 *
 * DIL is what the model writes: Markdown for prose, JSX-like tags for
 * components, and JavaScript for state and logic. This module turns a DIL
 * document into
 *
 *   1. a JavaScript **program** — plain calls to `__dil.jsx`, so any JavaScript
 *      runtime can evaluate it without a parser for DIL;
 *   2. a **constants** table — every static text run, so that as a response
 *      streams, growing text changes the data rather than the program;
 *   3. a list of **diagnostics** — properties dropped for failing catalog
 *      validation, tags auto-closed, incomplete constructs discarded.
 *
 * A dedicated format is needed because the model writes the interface token by
 * token, so the compiler also has to work on a half-written document:
 *
 *   * statements sit on their own lines and are dropped when unbalanced;
 *   * any open element is closed automatically at the cut;
 *   * a tag that is still being typed is rolled back to the last complete
 *     construct;
 *   * a trailing incomplete `${` interpolation is discarded.
 *
 * The compiler is dependency-free and shared by both halves of the plugin: the
 * Host compiles at tool-call time and persists the program (the durable
 * "model_dil_v2" record), and the browser compiles each partial response while
 * the arguments are still arriving.
 *
 * @module intelligent-ui/lib/compile
 */

import { COMPONENTS, validateProps, isComponent } from './catalog.js'

/* ------------------------------------------------------------------ *
 * Small JavaScript scanning helpers
 * ------------------------------------------------------------------ */

/**
 * Read a balanced `open`/`close` pair starting at `start`, respecting strings,
 * template literals, comments and nested brackets.
 *
 * @returns the inner text and the index just past the closing token, or `null`
 *   when the input ends before the pair closes (a partial response).
 */
function readBalanced(src, start, open, close, options) {
  if (src[start] !== open) return null
  // Markdown text can legitimately contain `//` (a URL). Comment handling is
  // therefore opt-out for the callers that scan prose rather than JavaScript.
  const comments = options === undefined || options.comments !== false
  let depth = 0
  let i = start
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(src, i)
      if (end === -1) return null
      i = end
      continue
    }
    if (comments && ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (comments && ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return { text: src.slice(start + 1, i), end: i + 1 }
    }
    i += 1
  }
  return null
}

/** Index just past a string literal starting at `start`, or `-1` when unterminated. */
function skipString(src, start) {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      const inner = readBalanced(src, i + 1, '{', '}')
      if (inner === null) return -1
      i = inner.end
      continue
    }
    if (ch === quote) return i + 1
    if (ch === '\n' && quote !== '`') return -1
    i += 1
  }
  return -1
}

/** Whether every bracket in `text` is balanced (outside strings and comments). */
function isBalanced(text) {
  const pairs = { '(': ')', '[': ']', '{': '}' }
  const stack = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i)
      if (end === -1) return false
      i = end
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return false
      i = end + 2
      continue
    }
    if (pairs[ch] !== undefined) stack.push(pairs[ch])
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) return false
    }
    i += 1
  }
  return stack.length === 0
}

/** Split on top-level commas (outside brackets, strings and comments). */
function splitTopLevel(text, separator = ',') {
  const parts = []
  let depth = 0
  let current = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = skipString(text, i)
      if (end === -1) { current += text.slice(i); break }
      current += text.slice(i, end)
      i = end
      continue
    }
    if ('([{'.includes(ch)) depth += 1
    else if (')]}'.includes(ch)) depth -= 1
    if (ch === separator && depth === 0) { parts.push(current); current = ''; i += 1; continue }
    current += ch
    i += 1
  }
  if (current.trim() !== '' || parts.length > 0) parts.push(current)
  return parts
}

/**
 * A literal-only reader for model-authored values.
 *
 * The compiler must never execute model output, so JSON-shaped literals are
 * parsed here by hand rather than handed to `new Function`. Anything with a
 * free identifier, a call, a member access or a stray token fails to parse and
 * is treated as a runtime expression instead.
 */
class LiteralReader {
  constructor(source) {
    this.source = source
    this.i = 0
  }

  ws() {
    while (this.i < this.source.length && /\s/.test(this.source[this.i])) this.i += 1
  }

  value() {
    this.ws()
    const ch = this.source[this.i]
    if (ch === undefined) return { ok: false }
    if (ch === '[') return this.array()
    if (ch === '{') return this.object()
    if (ch === '"' || ch === "'") return this.string()
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.source.startsWith(word, this.i)) {
        this.i += word.length
        return { ok: true, value }
      }
    }
    return this.number()
  }

  number() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/.exec(this.source.slice(this.i))
    if (match === null) return { ok: false }
    this.i += match[0].length
    return { ok: true, value: Number(match[0]) }
  }

  string() {
    const end = skipString(this.source, this.i)
    if (end === -1) return { ok: false }
    const raw = this.source.slice(this.i, end)
    this.i = end
    // Decode JSON escapes for double-quoted literals by hand; single-quoted
    // strings are taken verbatim apart from backslash escapes.
    let out = ''
    for (let k = 1; k < raw.length - 1; k += 1) {
      if (raw[k] !== '\\') { out += raw[k]; continue }
      const next = raw[k + 1]
      k += 1
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === 'u') {
        const hex = raw.slice(k + 1, k + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); k += 4 }
        else out += 'u'
      } else out += next
    }
    return { ok: true, value: out }
  }

  array() {
    const result = []
    this.i += 1
    for (;;) {
      this.ws()
      if (this.source[this.i] === ']') { this.i += 1; return { ok: true, value: result } }
      const item = this.value()
      if (!item.ok) return { ok: false }
      result.push(item.value)
      this.ws()
      if (this.source[this.i] === ',') { this.i += 1; continue }
      if (this.source[this.i] === ']') { this.i += 1; return { ok: true, value: result } }
      return { ok: false }
    }
  }

  object() {
    const result = {}
    this.i += 1
    for (;;) {
      this.ws()
      if (this.source[this.i] === '}') { this.i += 1; return { ok: true, value: result } }
      const key = this.source[this.i] === '"' || this.source[this.i] === "'"
        ? this.string()
        : this.identifier()
      if (!key.ok) return { ok: false }
      this.ws()
      if (this.source[this.i] !== ':') return { ok: false }
      this.i += 1
      const item = this.value()
      if (!item.ok) return { ok: false }
      result[key.value] = item.value
      this.ws()
      if (this.source[this.i] === ',') { this.i += 1; continue }
      if (this.source[this.i] === '}') { this.i += 1; return { ok: true, value: result } }
      return { ok: false }
    }
  }

  identifier() {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.source.slice(this.i))
    if (match === null) return { ok: false }
    this.i += match[0].length
    return { ok: true, value: match[0] }
  }
}

/** Parse a literal-only source fragment; `{ ok: false }` when it is really an expression. */
export function parseLiteral(source) {
  const reader = new LiteralReader(String(source))
  const result = reader.value()
  if (!result.ok) return { ok: false }
  reader.ws()
  if (reader.i !== reader.source.length) return { ok: false }
  return result
}

/** Whether `text` is a self-contained literal with no free identifiers. */
function isLiteralExpression(text) {
  return parseLiteral(text).ok
}

/* ------------------------------------------------------------------ *
 * Node model
 * ------------------------------------------------------------------ */

/** `{ kind: 'el', tag, props, children }` — one component instance. */
function element(tag, props, children) {
  return { kind: 'el', tag, props, children }
}

/** `{ kind: 'text', text }` — static text; lands in the constants table. */
function textNode(text) {
  return { kind: 'text', text }
}

/** `{ kind: 'expr', code }` — a JavaScript expression evaluated at render time. */
function exprNode(code) {
  return { kind: 'expr', code }
}

/* ------------------------------------------------------------------ *
 * Tag scanning (JSX-like)
 * ------------------------------------------------------------------ */

/** Which character ends a text run inside an element. */
const TAG_STOP = new Set(['<', '{'])

/**
 * JSX-like whitespace rules for text inside an element: a run that spans a line
 * break is trimmed at its edges and its inner whitespace collapses to one
 * space, and a run that is nothing but the indentation between two child
 * elements disappears entirely.
 */
function normalizeMarkupText(text) {
  if (!text.includes('\n')) return text
  let out = text
  const hadLeading = /^[ \t]*\n/.test(out)
  if (hadLeading) out = out.replace(/^[ \t]*\n/, '')
  const hadTrailing = /\n[ \t]*$/.test(out)
  if (hadTrailing) out = out.replace(/\n[ \t]*$/, '')
  out = out.replace(/[ \t]*\n[ \t]*/g, ' ')
  if (hadLeading) out = out.replace(/^[ \t]+/, '')
  if (hadTrailing) out = out.replace(/[ \t]+$/, '')
  return out.trim() === '' ? '' : out
}

/**
 * Parse a run of JSX-like markup into nodes.
 *
 * Never throws and never requires balanced input: a tag still being typed is
 * rolled back to the last complete position and every element still open at the
 * cut is closed automatically. That is what makes a half-written response
 * renderable.
 *
 * @param source - markup run (no Markdown block structure inside).
 * @param diagnostics - collector for `unclosed_tag` / `dropped_incomplete`.
 * @returns parsed nodes plus the index of the last complete construct.
 */
function parseMarkup(source, diagnostics) {
  const root = { children: [] }
  const stack = [root]
  let i = 0
  let lastGood = 0
  const top = () => stack[stack.length - 1].children
  const pushText = (raw) => {
    const text = normalizeMarkupText(raw)
    if (text === '') return
    const list = top()
    const previous = list[list.length - 1]
    if (previous !== undefined && previous.kind === 'text') previous.text += text
    else list.push(textNode(text))
  }

  while (i < source.length) {
    const ch = source[i]

    if (ch === '<') {
      if (source[i + 1] === '/') {
        const end = source.indexOf('>', i)
        if (end === -1) break
        const name = source.slice(i + 2, end).trim()
        // Close the nearest matching open element; discard anything nested inside it.
        let depth = stack.length - 1
        while (depth > 0 && stack[depth].tag !== name) depth -= 1
        if (depth === 0) {
          diagnostics.push({ code: 'stray_close_tag', tag: name })
        } else {
          stack.length = depth
        }
        i = end + 1
        lastGood = i
        continue
      }

      const tag = parseTag(source, i)
      if (tag === null) break // still being typed: roll back to `lastGood`
      const { name, props, selfClosing, end } = tag
      const node = element(name, props, [])
      top().push(node)
      i = end
      lastGood = i
      if (!selfClosing) stack.push(node)
      continue
    }

    if (ch === '{') {
      // A bare `{ ... }` inside markup is one expression child.
      const inner = readBalanced(source, i, '{', '}')
      if (inner === null) break
      const content = inner.text.trim()
      if (content.startsWith('@')) {
        diagnostics.push({ code: 'statement_in_markup', text: content.slice(0, 24) })
      } else if (content !== '') {
        top().push(exprNode(content))
      }
      i = inner.end
      lastGood = i
      continue
    }

    // Text run.
    let end = i
    while (end < source.length && !TAG_STOP.has(source[end])) end += 1
    pushText(source.slice(i, end))
    i = end
    lastGood = i
  }

  // Anything still open at the cut is closed automatically.
  for (let depth = stack.length - 1; depth > 0; depth -= 1) {
    diagnostics.push({ code: 'unclosed_tag', tag: stack[depth].tag, autoClosed: true })
    lastGood = source.length
  }
  if (lastGood < source.length) {
    diagnostics.push({ code: 'dropped_incomplete', at: lastGood })
  }
  return { children: root.children, consumed: lastGood }
}

/**
 * Parse one `<tag …>` / `<tag … />` head starting at `start`.
 * @returns `{ name, props, selfClosing, end }`, or `null` when the tag is still
 *   being typed (unterminated attribute or expression).
 */
function parseTag(source, start) {
  let i = start + 1
  const nameMatch = /^[A-Za-z][\w.-]*/.exec(source.slice(i))
  if (nameMatch === null) return null
  const name = nameMatch[0]
  i += name.length
  const props = []

  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (i >= source.length) return null
    if (source[i] === '>') return { name, props, selfClosing: false, end: i + 1 }
    if (source[i] === '/' && source[i + 1] === '>') return { name, props, selfClosing: true, end: i + 2 }
    if (source[i] === '{') {
      // `{…}` property spread: evaluated at render time and merged.
      const inner = readBalanced(source, i, '{', '}')
      if (inner === null) return null
      props.push({ name: '...', kind: 'spread', code: inner.text.trim() })
      i = inner.end
      continue
    }

    const attrMatch = /^[A-Za-z_$][\w$:-]*/.exec(source.slice(i))
    if (attrMatch === null) return null
    const attrName = attrMatch[0]
    i += attrName.length
    while (i < source.length && /\s/.test(source[i])) i += 1

    if (source[i] === '=') {
      i += 1
      while (i < source.length && /\s/.test(source[i])) i += 1
      const next = source[i]
      if (next === '{') {
        const inner = readBalanced(source, i, '{', '}')
        if (inner === null) return null
        const code = inner.text.trim()
        props.push(
          isLiteralExpression(code)
            ? { name: attrName, kind: 'lit', value: evaluateLiteral(code), code }
            : { name: attrName, kind: 'expr', code },
        )
        i = inner.end
        continue
      }
      if (next === '"' || next === "'") {
        const end = skipString(source, i)
        if (end === -1) return null
        const raw = source.slice(i, end)
        props.push({ name: attrName, kind: 'lit', value: evaluateLiteral(raw), code: raw })
        i = end
        continue
      }
      const literalMatch = /^[^\s/>]+/.exec(source.slice(i))
      if (literalMatch === null) return null
      const raw = literalMatch[0]
      if (!isLiteralExpression(raw)) return null
      props.push({ name: attrName, kind: 'lit', value: evaluateLiteral(raw), code: raw })
      i += raw.length
      continue
    }

    props.push({ name: attrName, kind: 'lit', value: true, code: 'true' })
  }
}

/** Read a literal source fragment written by the model. Never executes it. */
function evaluateLiteral(code) {
  const parsed = parseLiteral(code)
  if (parsed.ok) return parsed.value
  const trimmed = String(code).trim()
  if (trimmed === 'undefined') return undefined
  return trimmed
}

/* ------------------------------------------------------------------ *
 * Inline Markdown
 * ------------------------------------------------------------------ */

/**
 * Parse one run of Markdown prose (and any inline components inside it) into
 * nodes: `**bold**` → `<bold>`, `` `code` `` → `<code>`, `[t](u)` → `<link>`,
 * `${expr}` → an expression child, `<tag>` → a component.
 */
function parseInline(source, diagnostics) {
  const out = []
  let buffer = ''
  let i = 0

  const flush = () => {
    if (buffer !== '') { out.push(textNode(buffer)); buffer = '' }
  }

  while (i < source.length) {
    const ch = source[i]

    if (ch === '\\' && i + 1 < source.length) { buffer += source[i + 1]; i += 2; continue }

    if (ch === '$' && source[i + 1] === '{') {
      const inner = readBalanced(source, i + 1, '{', '}')
      if (inner === null) {
        diagnostics.push({ code: 'dropped_incomplete', construct: 'interpolation' })
        i = source.length
        continue
      }
      flush()
      const code = inner.text.trim()
      if (code !== '') out.push(exprNode(code))
      i = inner.end
      continue
    }

    if (ch === '<') {
      const parsed = parseMarkup(source.slice(i), diagnostics)
      if (parsed.children.length > 0) {
        flush()
        for (const child of parsed.children) out.push(child)
      }
      if (parsed.consumed === 0) { buffer += '<'; i += 1; continue }
      i += parsed.consumed
      continue
    }

    if (source.startsWith('**', i) || source.startsWith('__', i)) {
      const marker = source.slice(i, i + 2)
      const close = source.indexOf(marker, i + 2)
      if (close === -1) { buffer += marker; i += 2; continue }
      flush()
      out.push(element('bold', [], parseInline(source.slice(i + 2, close), diagnostics)))
      i = close + 2
      continue
    }

    if (ch === '*' || ch === '_') {
      const close = source.indexOf(ch, i + 1)
      // Require a non-empty span that does not start or end with a space, so
      // `2 * 3` and `snake_case` stay literal.
      if (close > i + 1 && !/\s/.test(source[i + 1]) && !/\s/.test(source[close - 1])) {
        flush()
        out.push(element('italic', [], parseInline(source.slice(i + 1, close), diagnostics)))
        i = close + 1
        continue
      }
      buffer += ch
      i += 1
      continue
    }

    if (ch === '`') {
      const close = source.indexOf('`', i + 1)
      if (close === -1) { buffer += ch; i += 1; continue }
      flush()
      out.push(element('code', [], [textNode(source.slice(i + 1, close))]))
      i = close + 1
      continue
    }

    if (ch === '[') {
      const label = readBalanced(source, i, '[', ']', { comments: false })
      if (label !== null && source[label.end] === '(') {
        const target = readBalanced(source, label.end, '(', ')', { comments: false })
        if (target !== null) {
          flush()
          out.push(
            element('link', [{ name: 'href', kind: 'lit', value: target.text.trim(), code: JSON.stringify(target.text.trim()) }],
              parseInline(label.text, diagnostics)),
          )
          i = target.end
          continue
        }
      }
      buffer += ch
      i += 1
      continue
    }

    buffer += ch
    i += 1
  }

  flush()
  return out
}

/* ------------------------------------------------------------------ *
 * Block structure
 * ------------------------------------------------------------------ */

const HEADING_SIZE = { 1: '2xl', 2: 'lg', 3: 'md', 4: 'sm', 5: 'sm', 6: 'xs' }

/** Index of the end of a fenced code block, or `-1`. */
function fenceEnd(lines, start) {
  const fence = /^\s*(```|~~~)/.exec(lines[start])
  if (fence === null) return -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith(fence[1])) return i
  }
  return lines.length // still streaming: treat the open fence as ended at the cut
}

/**
 * How much markup is still open in a run of lines.
 *
 * Used to decide where a markup block ends while the model is still writing it:
 * a block continues while at least one element or one tag is unfinished, so a
 * tag spread across several lines — the shape a model naturally produces — is
 * gathered whole instead of being cut after its first line.
 *
 * @returns `{ depth, partial }`; `partial` means the run stops inside a tag or
 *   inside a `{ … }` attribute expression.
 */
function markupState(source) {
  let depth = 0
  let partial = false
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === '{') {
      const inner = readBalanced(source, i, '{', '}')
      if (inner === null) { partial = true; break }
      i = inner.end
      continue
    }
    if (ch !== '<') { i += 1; continue }
    if (source[i + 1] === '/') {
      const end = source.indexOf('>', i)
      if (end === -1) { partial = true; break }
      depth -= 1
      i = end + 1
      continue
    }
    const parsed = parseTag(source, i)
    if (parsed === null) { partial = true; break }
    if (!parsed.selfClosing) depth += 1
    i = parsed.end
  }
  return { depth, partial }
}

/**
 * Turn a DIL document into an ordered list of blocks.
 *
 * @returns `{ blocks, diagnostics }` where a block is one of
 *   `{ type: 'markup' | 'statement' | 'heading' | 'paragraph' | 'list' | 'quote' | 'fence' | 'divider', … }`.
 */
export function scanDocument(source, diagnostics = []) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') { i += 1; continue }

    // Fenced code.
    if (/^\s*(```|~~~)/.test(line)) {
      const end = fenceEnd(lines, i)
      const opener = line.trim().replace(/^\s*(```|~~~)/, '')
      blocks.push({ type: 'fence', language: opener.trim(), lines: lines.slice(i + 1, end) })
      i = Math.min(end + 1, lines.length)
      continue
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i += 1
      continue
    }

    // Thematic break.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'divider' }); i += 1; continue }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const collected = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        collected.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: collected.join(' ') })
      continue
    }

    // Statement: `{@body …}` or a bare `{ … }` on its own line.
    if (/^\s*\{/.test(line)) {
      const start = line.indexOf('{')
      const gathered = []
      let cursor = i
      let statementText = null
      while (cursor < lines.length) {
        gathered.push(cursor === i ? lines[cursor].slice(start) : lines[cursor])
        const read = readBalanced(gathered.join('\n'), 0, '{', '}')
        if (read !== null) { statementText = read.text; break }
        cursor += 1
      }
      const complete = statementText !== null
      const statementLines = gathered.map((entry, index) => (index === 0 ? entry.slice(1) : entry))
      blocks.push({
        type: 'statement',
        raw: complete ? statementText : statementLines.join('\n'),
        complete,
      })
      i = complete ? cursor + 1 : lines.length
      continue
    }

    // List.
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch !== null) {
      const ordered = /\d/.test(listMatch[2])
      const items = []
      while (i < lines.length) {
        const itemMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (itemMatch === null) {
          if (items.length > 0 && /^\s+\S/.test(lines[i]) && lines[i].trim() !== '') {
            items[items.length - 1] += ` ${lines[i].trim()}`
            i += 1
            continue
          }
          break
        }
        items.push(itemMatch[3])
        i += 1
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // Markup block: a line whose first non-space character opens a tag. It runs
    // until every element is closed and every tag is finished, so a multi-line
    // opening tag is one block rather than a broken one plus a stray paragraph.
    if (/^\s*</.test(line)) {
      const collected = []
      let accumulated = ''
      while (i < lines.length) {
        accumulated = accumulated === '' ? lines[i] : `${accumulated}\n${lines[i]}`
        collected.push(lines[i])
        i += 1
        const state = markupState(accumulated)
        if (state.depth <= 0 && !state.partial) break
      }
      blocks.push({ type: 'markup', source: collected.join('\n') })
      continue
    }

    // Paragraph.
    const paragraph = []
    while (i < lines.length) {
      const candidate = lines[i]
      if (candidate.trim() === '') break
      if (/^\s*(```|~~~)/.test(candidate)) break
      if (/^(#{1,6})\s+/.test(candidate)) break
      if (/^\s*>\s?/.test(candidate)) break
      if (/^\s*\{/.test(candidate)) break
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(candidate)) break
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(candidate)) break
      if (/^\s*</.test(candidate)) break
      paragraph.push(candidate.trim())
      i += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
  }

  return { blocks, diagnostics }
}

/* ------------------------------------------------------------------ *
 * Document → node tree + hoisted statements
 * ------------------------------------------------------------------ */

/**
 * Lower the block list into a render tree plus the JavaScript statements that
 * must run before it.
 *
 * Markdown lowers into the same tree as the components: a heading becomes a
 * `title`, a paragraph a `text`, a list a `list` of `item`s. So the runtime
 * only ever sees components.
 */
export function lowerDocument(source, diagnostics = []) {
  const { blocks } = scanDocument(source, diagnostics)
  const statements = []
  const children = []

  for (const block of blocks) {
    switch (block.type) {
      case 'statement': {
        if (!block.complete) {
          diagnostics.push({ code: 'dropped_incomplete', construct: 'statement', text: block.raw.slice(0, 40) })
          break
        }
        statements.push(block.raw.trim())
        break
      }
      case 'heading':
        children.push(element('title', [{ name: 'size', kind: 'lit', value: HEADING_SIZE[block.level] ?? 'md', code: JSON.stringify(HEADING_SIZE[block.level] ?? 'md') }], parseInline(block.text, diagnostics)))
        break
      case 'paragraph': {
        const inline = parseInline(block.text, diagnostics)
        if (inline.length > 0) children.push(element('text', [], inline))
        break
      }
      case 'list': {
        const items = block.items.map((item) => element('item', [], parseInline(item, diagnostics)))
        const ordered = block.ordered
        children.push(element('list', [{ name: 'ordered', kind: 'lit', value: ordered, code: String(ordered) }], items))
        break
      }
      case 'quote':
        children.push(element('quote', [], parseInline(block.text, diagnostics)))
        break
      case 'divider':
        children.push(element('divider', [], []))
        break
      case 'fence': {
        const code = block.lines.join('\n')
        children.push(
          element('codeblock',
            block.language === '' ? [] : [{ name: 'language', kind: 'lit', value: block.language, code: JSON.stringify(block.language) }],
            [textNode(code)]),
        )
        break
      }
      case 'markup': {
        const { children: parsed } = parseMarkup(block.source, diagnostics)
        for (const node of parsed) children.push(node)
        break
      }
      default:
        break
    }
  }

  return { children, statements }
}

/* ------------------------------------------------------------------ *
 * Statement rewriting
 * ------------------------------------------------------------------ */

/** Give each `DIL.useState` / `DIL.useReducer` call a stable key. */
function withStateKey(statement) {
  const match = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*|\[[^\]]*\]|\{[\s\S]*?\})\s*=\s*(DIL\.use(?:State|Reducer))\s*\(/.exec(statement)
  if (match === null) return statement
  const declaration = match[1]
  let key = null
  if (declaration.startsWith('[')) {
    const first = declaration.slice(1, -1).split(',')[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(first)) key = first
  } else if (!declaration.startsWith('{')) {
    key = declaration
  }
  if (key === null) return statement

  const openIndex = match.index + match[0].length - 1
  const call = readBalanced(statement, openIndex, '(', ')')
  if (call === null) return statement
  if (splitTopLevel(call.text).length > 1) return statement // already carries options
  return `${statement.slice(0, call.end - 1)}, { key: ${JSON.stringify(key)} }${statement.slice(call.end - 1)}`
}

/**
 * Wrap a derived binding so an expression that throws removes one value
 * instead of aborting the whole render.
 */
function withSafeInitializer(statement, diagnostics) {
  if (/\bDIL\.use[A-Z]/.test(statement)) return statement
  if (/^\s*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.test(statement) === false) {
    if (/^\s*(function|class|for|while|if|switch|try|\/\/|\/\*)/.test(statement)) return statement
    if (/^\s*return\b/.test(statement)) {
      diagnostics.push({ code: 'dropped_return', text: statement.slice(0, 40) })
      return null
    }
    if (!isBalanced(statement)) return statement
    return `__dilSafe(() => (${stripTrailingSemicolon(statement)}), undefined);`
  }
  const match = /^\s*(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);?\s*$/.exec(statement)
  if (match === null) return statement
  const initializer = match[3]
  if (isLiteralExpression(initializer)) return statement
  return `${match[1]} ${match[2]} = __dilSafe(() => (${initializer}), undefined);`
}

function stripTrailingSemicolon(text) {
  return text.trim().replace(/;\s*$/, '')
}

/* ------------------------------------------------------------------ *
 * Code generation
 * ------------------------------------------------------------------ */

class Constants {
  constructor(inline = false) {
    this.inline = inline
    this.values = {}
    this.next = 0
    this.index = new Map()
  }

  add(text) {
    const existing = this.index.get(text)
    if (existing !== undefined) return existing
    const key = String(this.next)
    this.next += 1
    this.values[key] = text
    this.index.set(text, key)
    return key
  }

  /**
   * How this table is referenced from generated code.
   *
   * The program body reads its text from the constants table, so growing text
   * changes the data rather than the program. A composite has no table of its
   * own, so it inlines the literal instead.
   */
  ref(text) {
    const key = this.add(text)
    return this.inline ? JSON.stringify(text) : `__dilConstants[${JSON.stringify(key)}]`
  }
}

/** Emit the `__dil.jsx(...)` call for one node. */
function emitNode(node, constants, state) {
  if (node.kind === 'text') return constants.ref(node.text)
  if (node.kind === 'expr') {
    state.expressionCount += 1
    return `__dilSafe(() => (${node.code}), null)`
  }

  state.nodeCount += 1
  const component = node.tag
  const known = COMPONENTS[component] !== undefined
  const literalProps = {}
  for (const prop of node.props) {
    if (prop.kind === 'lit') literalProps[prop.name] = prop.value
  }

  const { props: accepted, diagnostics } = validateProps(component, literalProps)
  for (const diagnostic of diagnostics) state.diagnostics.push(diagnostic)

  const propsSource = []
  for (const [name, value] of Object.entries(accepted)) {
    if (value === undefined) continue
    propsSource.push(`${name}: ${JSON.stringify(value)}`)
  }
  let hasExpression = false
  for (const prop of node.props) {
    if (prop.kind === 'lit') continue
    if (prop.kind === 'spread') {
      hasExpression = true
      propsSource.push(`...__dilSafe(() => (${prop.code}), {})`)
      continue
    }
    if (known && COMPONENTS[component].props[prop.name] === undefined) {
      state.diagnostics.push({ code: 'unknown_prop', component, prop: prop.name })
      continue
    }
    hasExpression = true
    // Property expressions are not wrapped individually: the whole element is
    // isolated instead, so a property that throws removes that element — which
    // is exactly what the reference capture shows (`value: seats` bare, inside a
    // wrapped `__dil.jsx` call).
    propsSource.push(`${prop.name}: (${prop.code})`)
  }

  const children = node.children.map((child) => emitNode(child, constants, state))
  const call = `__dil.jsx(${JSON.stringify(component)}, ${propsSource.length > 0 ? `{ ${propsSource.join(', ')} }` : 'null'}${children.length > 0 ? `, ${children.join(', ')}` : ''})`

  // Error isolation: an element whose properties are not all literals is wrapped,
  // so an expression that throws removes that one element instead of aborting
  // the whole render.
  return hasExpression ? `__dilSafe(() => ${call}, null)` : call
}

/** Render the constants bag as a plain object literal. */
function constantsSource(constants) {
  const entries = Object.entries(constants.values).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  return `{ ${entries.join(', ')} }`
}

/**
 * A prose rendering of the document, for a client without a runtime.
 *
 * The Markdown-derived blocks are kept verbatim; component tags and statement
 * lines are the *interface*, not the prose, so they are dropped whole rather
 * than stripped down to their text residue.
 */
export function fallbackMarkdown(source) {
  const { blocks } = scanDocument(String(source ?? ''))
  const out = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`${'#'.repeat(block.level)} ${block.text}`, '')
        break
      case 'paragraph':
        out.push(block.text, '')
        break
      case 'list':
        out.push(...block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : '-'} ${item}`), '')
        break
      case 'quote':
        out.push(`> ${block.text}`, '')
        break
      case 'divider':
        out.push('---', '')
        break
      case 'fence':
        out.push(`\`\`\`${block.language}`, ...block.lines, '\`\`\`', '')
        break
      default:
        break
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Compile a DIL document.
 *
 * @param source - the DIL the model wrote, complete or still streaming.
 * @param options - `{ detail }` reserved for future compiler switches.
 * @returns `{ code, constants, diagnostics, fallbackMarkdown, stats }`.
 *   `code` is a JavaScript program expressing the interface as plain
 *   `__dil.jsx` calls; `constants` holds its static text.
 */
export function compileDil(source, options = {}) {
  const diagnostics = []
  const text = String(source ?? '')
  const { children, statements } = lowerDocument(text, diagnostics)
  const constants = new Constants()
  const state = { diagnostics, nodeCount: 0, expressionCount: 0 }

  const body = []
  for (const raw of statements) {
    let statement = raw.trim()
    if (statement === '') continue
    // `{@body …}` declares a statement in the render function's body. Other
    // scopes are not part of the format and are reported rather than guessed at.
    const scope = /^@([A-Za-z_$][\w$]*)\s*/.exec(statement)
    if (scope !== null) {
      if (scope[1] !== 'body') {
        diagnostics.push({ code: 'unsupported_scope', text: statement.slice(0, 32) })
        continue
      }
      statement = statement.slice(scope[0].length)
    }
    if (statement === '') continue
    const keyed = withStateKey(statement)
    const safe = withSafeInitializer(keyed, diagnostics)
    if (safe === null) continue
    body.push(/;\s*$/.test(safe) ? safe : `${safe};`)
  }

  const rendered = children.map((child) => emitNode(child, constants, state))
  const bodyKey = `body:${body.length}`

  const lines = []
  lines.push('function __dilSafe(evaluate, failureValue) { try { return evaluate(); } catch { return failureValue; } }')
  lines.push('')
  lines.push('DIL.render(__dil.jsx(() => {')
  lines.push('  const __dilConstants = DIL.useConstants();')
  lines.push("  const __dilModelDataBindings = DIL.useAppData((appData) => appData.opGenui?.modelDataBindings ?? {});")
  lines.push('  void __dilModelDataBindings;')
  for (const statement of body) lines.push(`  ${statement}`)
  lines.push(`  return __dil.jsx(__dil.Fragment, null${rendered.length > 0 ? `,\n    ${rendered.join(',\n    ')}` : ''});`)
  lines.push(`}, { key: ${JSON.stringify(bodyKey)} }));`)

  const code = lines.join('\n')
  state.diagnostics.push(...diagnostics)

  return {
    code,
    constants: constants.values,
    diagnostics: dedupeDiagnostics(state.diagnostics),
    fallbackMarkdown: fallbackMarkdown(text),
    stats: {
      nodes: state.nodeCount,
      constants: Object.keys(constants.values).length,
      statements: body.length,
      expressions: state.expressionCount,
      bytes: code.length,
    },
  }
}

function dedupeDiagnostics(diagnostics) {
  const seen = new Set()
  const out = []
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify(diagnostic)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(diagnostic)
  }
  return out
}

/**
 * Compile and immediately report the catalogue components the document used —
 * handy for receipts and for the client's "unknown component" fallback.
 */
export function compileSummary(source) {
  const result = compileDil(source)
  const used = new Set()
  const collect = (nodes) => {
    for (const node of nodes) {
      if (node.kind !== 'el') continue
      used.add(node.tag)
      collect(node.children)
    }
  }
  collect(lowerDocument(String(source ?? '')).children)
  return {
    ...result,
    components: [...used].sort(),
    unknownComponents: [...used].filter((name) => !isComponent(name)),
  }
}


/* ------------------------------------------------------------------ *
 * Composite components
 * ------------------------------------------------------------------ */

/**
 * Compile a composite component body into a function expression.
 *
 * Composite components are written in DIL and shipped to the sandbox prebuilt —
 * the same relationship ChatGPT's image and product components have to the
 * catalog. The model uses them like any other tag; they lower into native
 * components before the renderer ever sees them.
 *
 * Their body works on `props`, may build dynamic lists with `DIL.h(...)`, and
 * must be pure: a composite that needs state shares one slot across every
 * instance, so prefer keeping state in the card body instead.
 *
 * @param source - the composite's DIL body.
 * @param propNames - the properties to destructure from `props`.
 * @returns `{ code, constants, diagnostics }` where `code` is a function expression.
 */
export function compileComposite(source, propNames = []) {
  const diagnostics = []
  const { children, statements } = lowerDocument(String(source ?? ''), diagnostics)
  const constants = new Constants(true)
  const state = { diagnostics, nodeCount: 0, expressionCount: 0 }

  const body = []
  for (const raw of statements) {
    let statement = raw.trim()
    if (statement === '') continue
    const scope = /^@([A-Za-z_$][\w$]*)\s*/.exec(statement)
    if (scope !== null) {
      if (scope[1] !== 'body') {
        diagnostics.push({ code: 'unsupported_scope', text: statement.slice(0, 32) })
        continue
      }
      statement = statement.slice(scope[0].length)
    }
    if (statement === '') continue
    const safe = withSafeInitializer(withStateKey(statement), diagnostics)
    if (safe === null) continue
    body.push(/;\s*$/.test(safe) ? safe : `${safe};`)
  }

  const rendered = children.map((child) => emitNode(child, constants, state))
  const names = [...new Set(propNames)].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))

  const lines = []
  lines.push('function (props) {')
  lines.push('  function __dilSafe(evaluate, failureValue) { try { return evaluate(); } catch { return failureValue; } }')
  if (names.length > 0) lines.push(`  const { ${names.join(', ')} } = props || {};`)
  for (const statement of body) lines.push(`  ${statement}`)
  lines.push(`  return __dil.jsx(__dil.Fragment, null${rendered.length > 0 ? `,\n    ${rendered.join(',\n    ')}` : ''});`)
  lines.push('}')

  return { code: lines.join('\n'), constants: {}, diagnostics: dedupeDiagnostics([...state.diagnostics, ...diagnostics]) }
}

export { parseInline, parseMarkup, isBalanced, readBalanced }
