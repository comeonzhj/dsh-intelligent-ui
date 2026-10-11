/**
 * Intelligent UI — the browser half.
 *
 * Wiring, in the order the article's pipeline runs:
 *
 *   1. **inference format** — the model writes DIL into the `render_ui` tool
 *      arguments, which stream in through the tool-call channel;
 *   2. **compilation** — every partial response is recompiled (throttled) into a
 *      program plus a constants table, and a program that fails to evaluate
 *      leaves the last one that worked on screen;
 *   3. **runtime** — the program is posted into a sandboxed runner that
 *      reconciles it and answers with operations;
 *   4. **rendering** — the operations are applied to this client's own
 *      component tree (see `components.js`);
 *   5. **interaction** — the user's clicks go back to the runner as a handler
 *      identifier and arguments, and the interface updates with no model call.
 *
 * The card also owns the way back to the model: a `submit` control sends the
 * collected named values as the user's next message.
 *
 * @module intelligent-ui/src/client/app
 */

import { compileDil } from '../../lib/compile.js'
import { createDilRuntime, decodeTree, ROOT_ID } from '../runtime/runtime.js'
import { buildComposites } from '../../lib/composite.js'

/** Package name; also the `dsh.client` module id and the style-tag owner. */
export const PLUGIN_NAME = '@comeonzhj/dsh-intelligent-ui'

/** Locale namespace; the renderer synthesizes `t` from it. */
export const NS = 'intelligent-ui'

/** Wire name of the delivery tool. Must equal the Host tool name. */
export const TOOL_NAME = 'render_ui'

/** Wire name of the mid-task clarification tool. */
export const ASK_TOOL_NAME = 'ask_with_ui'

/** Every tool whose call this half renders, newest first is the resolver's job. */
export const CARD_TOOLS = Object.freeze([TOOL_NAME, ASK_TOOL_NAME])

/** What the card does while a control is being touched but nothing has been sent. */
const WATCHDOG_MS = 2500
const MAX_PARTIAL_BYTES = 96 * 1024

/**
 * Card chrome.
 *
 * Shapes the runner's output only; every colour comes from the harness tokens so
 * light and dark both resolve. The motion values are the ones the article
 * reports for ChatGPT: text fades in over 0.7s, new rows slide in over 0.42s,
 * and containers transition their height instead of jumping.
 */
const CARD_CSS = `
.iui-root{--iui-gap:10px;display:flex;flex-direction:column;gap:var(--iui-gap);min-width:0;width:100%;font-size:14px;line-height:1.6;color:var(--dsw-alias-label-primary,#1b1f27)}
.iui-root *{box-sizing:border-box}
.iui-frame{display:flex;flex-direction:column;gap:8px;min-width:0;transition:height .28s cubic-bezier(.4,0,.2,1)}
.iui-head{display:flex;align-items:center;gap:8px;min-width:0}
.iui-head-title{font-size:12px;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-secondary,#5a6474);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iui-head-rule{flex:1 1 auto;height:.5px;background:var(--dsw-alias-border-l2,rgba(20,26,40,.1))}
.iui-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:10px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8a93a3);background:var(--dsw-alias-bg-layer-3,#eceef4);white-space:nowrap}
.iui-live{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-state-business-primary,#2f6bff)}
.iui-live-dot{width:5px;height:5px;border-radius:999px;background:currentColor;animation:iui-pulse 1.1s ease-in-out infinite}
.iui-anim-text{animation:iui-fade .7s cubic-bezier(.4,0,.2,1) both}
.iui-anim-row{animation:iui-slide .42s cubic-bezier(.4,0,.2,1) both}
.iui-wait{display:flex;flex-direction:column;gap:8px}
.iui-wait-bar{height:9px;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-bg-skeleton,#eceef4) 0%,var(--dsw-alias-bg-layer-3,#f4f5f8) 50%,var(--dsw-alias-bg-skeleton,#eceef4) 100%);background-size:200% 100%;animation:iui-shimmer 1.4s linear infinite}
.iui-foot{display:flex;flex-direction:column;gap:8px;padding-top:2px}
.iui-foot-note{width:100%;box-sizing:border-box;resize:none;overflow-y:hidden;min-height:34px;padding:7px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(20,26,40,.1));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:13px;line-height:21px;outline:none;transition:border-color .15s ease}
.iui-textarea{font:inherit;color:inherit;outline:none;transition:border-color .15s ease}
.iui-textarea:focus,.iui-foot-row{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.iui-foot-hint{flex:1 1 auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a3)}
.iui-send{appearance:none;border:none;font:inherit;font-size:13px;font-weight:500;padding:7px 16px;border-radius:8px;cursor:pointer;background:var(--dsw-alias-button-primary-fill,#2f6bff);color:var(--dsw-alias-label-primary-foreground,#fff);transition:filter .15s ease}
.iui-send:hover{filter:brightness(1.06)}
.iui-send:disabled{opacity:.5;cursor:default}
.iui-sent{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-state-success-primary,#12854a)}
.iui-problem{padding:8px 12px;border-radius:8px;font-size:12px;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-state-warn-primary,#b06a00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b06a00) 10%,transparent)}
.iui-diag{display:flex;flex-wrap:wrap;gap:6px;font-size:10px;font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-tertiary,#8a93a3)}
.iui-diag span{padding:0 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-3,#eceef4)}
.iui-receipt{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#5a6474);background:var(--dsw-alias-bg-layer-3,#eceef4)}
.iui-receipt-mark{color:var(--dsw-alias-state-business-primary,#2f6bff)}
@keyframes iui-fade{from{opacity:0}to{opacity:1}}
@keyframes iui-slide{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes iui-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@keyframes iui-pulse{0%,100%{opacity:.35}50%{opacity:1}}
`

/* ------------------------------------------------------------------ *
 * Partial tool arguments
 * ------------------------------------------------------------------ */

/** Undo the JSON escapes of one string body. */
function unescapeJson(body) {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') { out += ch; continue }
    const next = body[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else if (next === 'r') out += '\r'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === 'u') {
      const hex = body.slice(i + 1, i + 5)
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4 }
    } else if (next !== undefined) out += next
  }
  return out
}

/**
 * Read one string field out of an argument prefix that is still being written.
 *
 * A closed value is returned as is; an open one is returned with whatever has
 * arrived. That is the whole point: the DIL is streamed, and the compiler is
 * built to accept a document that stops mid-sentence.
 */
function readStreamingString(text, field) {
  const marker = `"${field}"`
  const at = text.indexOf(marker)
  if (at === -1) return null
  const colon = text.indexOf(':', at + marker.length)
  if (colon === -1) return null
  let i = colon + 1
  while (i < text.length && /\s/.test(text[i])) i += 1
  if (text[i] !== '"') return null
  i += 1
  let body = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      if (i + 1 >= text.length) break
      body += ch + text[i + 1]
      i += 2
      continue
    }
    if (ch === '"') return unescapeJson(body)
    body += ch
    i += 1
  }
  return unescapeJson(body)
}

/**
 * The raw argument text of a tool call, wherever the current phase keeps it.
 *
 * Three shapes, one meaning:
 *
 *   * `preparing` — nothing is dispatched yet, so the only source is the Tool
 *     layer's `useToolCallArgumentsPartial()` prefix, passed in as `partial`;
 *   * `start` — `StartedToolCall.argsRaw`, the complete arguments;
 *   * `result` — a `ToolResultNode`, whose call head is nested under `call`
 *     (`call` is null when window truncation dropped the call from the log).
 *
 * @returns the prefix to compile, or `''` when nothing has arrived.
 */
export function rawArgumentsText(phase, block, partial) {
  if (block === null || block === undefined) return partial ?? ''
  if (typeof block.argsRaw === 'string' && block.argsRaw !== '') return block.argsRaw
  const call = block.call
  if (call !== null && call !== undefined && typeof call.argsRaw === 'string') return call.argsRaw
  return partial ?? ''
}

/** Read a boolean field; absent until the value is complete. */
function readStreamingBoolean(text, field) {
  const marker = `"${field}"`
  const at = text.indexOf(marker)
  if (at === -1) return null
  const colon = text.indexOf(':', at + marker.length)
  if (colon === -1) return null
  const rest = text.slice(colon + 1)
  if (/^\s*true/.test(rest)) return true
  if (/^\s*false/.test(rest)) return false
  return null
}

/**
 * Extract the tool arguments from a prefix that may be truncated anywhere.
 * @param text - the raw argument prefix.
 * @returns `{ dil, title, surface, submitLabel, prompt, notePlaceholder, allowNote, complete }`.
 */
export function extractArgs(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.length > MAX_PARTIAL_BYTES) {
    return { dil: readStreamingString(source, 'dil') ?? '', truncated: true }
  }
  const submitLabel = readStreamingString(source, 'submitLabel')
  return {
    dil: readStreamingString(source, 'dil') ?? '',
    title: readStreamingString(source, 'title') ?? undefined,
    surface: readStreamingString(source, 'surface') ?? undefined,
    prompt: readStreamingString(source, 'prompt') ?? undefined,
    submitLabel: submitLabel ?? undefined,
    notePlaceholder: readStreamingString(source, 'notePlaceholder') ?? undefined,
    allowNote: readStreamingBoolean(source, 'allowNote'),
  }
}

/* ------------------------------------------------------------------ *
 * The sandboxed runner
 * ------------------------------------------------------------------ */

/**
 * The runner source, assembled from the same module text the page runs.
 *
 * `sources` is supplied by the generated bundle footer, which holds the
 * flattened text of `lib/catalog.js`, `lib/compile.js`, `lib/composite.js` and
 * `src/runtime/runtime.js`. Shipping the text rather than re-implementing the
 * modules keeps one behaviour for both halves.
 */
export function runnerFactorySource(sources) {
  return sources.runner
}

/** Build the `GenUI` catalog inside whatever scope the runtime lives in. */
const buildCatalog = (api) => buildComposites(api)

/* ------------------------------------------------------------------ *
 * Card lifecycle
 * ------------------------------------------------------------------ */

/**
 * One card's runner: owns the channel, the decoded node tree, and the way back
 * to the model.
 */
function createCard(options) {
  const sources = options.sources
  let channel = null
  let nodes = new Map()
  let root = { id: ROOT_ID, childrenOrder: [], children: [] }
  let latest = null
  let watchdog = null
  let disposed = false
  let generation = -1
  let latestProgram = null
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try { listener(latest) } catch { /* a listener must not break the card */ }
    }
  }

  /** A page-side handler posts the interaction back to the runner. */
  const onHandler = (handlerId) => (...args) => {
    if (disposed || channel === null) return
    guard()
    channel.post({ t: 'event', handler: handlerId, args })
  }

  const guard = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      // The program did not answer in time: quarantine the runner and rebuild.
      if (disposed) return
      restartRunner()
    }, WATCHDOG_MS)
  }

  const accept = (message) => {
    clearTimeout(watchdog)
    if (disposed) return
    if (message.ok === false) {
      // A program that fails to evaluate leaves the last one that worked on
      // screen, plus a quiet note about why.
      if (message.firstRender === true) {
        latest = { ...(latest ?? { nodes, root }), error: message.error ?? { message: 'program failed' } }
        notify()
      }
      return
    }
    if (message.firstRender === true) {
      // A fresh program restarts the node tree, so rebuild from scratch.
      nodes = new Map()
      root = { id: ROOT_ID, childrenOrder: [], children: [] }
    }
    if (message.generation !== undefined) generation = message.generation
    decodeTree(message, { nodes, root, onHandler })
    latest = { nodes, root, stats: message.stats, error: null, generation }
    notify()
  }

  function startChannel() {
    channel = createChannel({ sources, onMessage: accept })
  }

  function restartRunner() {
    if (channel !== null) channel.dispose()
    channel = null
    nodes = new Map()
    root = { id: ROOT_ID, childrenOrder: [], children: [] }
    startChannel()
    post(latestProgram)
  }

  function post(program) {
    if (program === null || channel === null) return
    guard()
    channel.post({ t: 'program', ...program })
  }

  startChannel()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /**
     * Send a compiled program. Called for every partial response, so state that
     * is keyed survives each recompilation.
     */
    load(program) {
      if (program === null) return
      if (program.code === latestProgram?.code) return
      latestProgram = program
      post(program)
    },
    /** Ask the runner to settle any pending state update. */
    poke() {
      if (channel !== null) channel.post({ t: 'rerender' })
    },
    snapshot() {
      return { nodes, root }
    },
    dispose() {
      disposed = true
      clearTimeout(watchdog)
      listeners.clear()
      if (channel !== null) channel.dispose()
      channel = null
    },
  }
}

/**
 * Create the message channel to a runner.
 *
 * The faithful layout is a Blob Web Worker: a separate global scope whose
 * network, timer and dynamic-evaluation surfaces are removed before the first
 * program runs. Two fallbacks keep the card working on a locked-down page: a
 * sandboxed iframe with a `default-src 'none'` policy, then an in-page
 * evaluation with the dangerous globals shadowed out of scope.
 */
function createChannel(options) {
  const attempts = [workerChannel, iframeChannel, inlineChannel]
  let lastError = null
  for (const attempt of attempts) {
    try {
      const channel = attempt(options)
      if (channel !== null) return channel
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no sandbox available')
}

function workerChannel({ sources, onMessage }) {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const blob = new Blob([runnerFactorySource(sources)], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  let worker
  try {
    worker = new Worker(url)
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  const listener = (event) => onMessage(event.data ?? {})
  worker.addEventListener('message', listener)
  worker.postMessage({ t: 'lockdown' })
  return {
    kind: 'worker',
    post(message) { try { worker.postMessage(message) } catch { /* channel closed */ } },
    dispose() {
      try { worker.removeEventListener('message', listener); worker.terminate() } catch { /* already gone */ }
      try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
    },
  }
}

function iframeChannel({ sources, onMessage }) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.display = 'none'
  const html = [
    '<!doctype html><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'">`,
    '<script>',
    'self.postMessage = function (message) { parent.postMessage(message, "*") }',
    runnerFactorySource(sources),
    '<\/script>',
  ].join('')
  frame.srcdoc = html
  const listener = (event) => {
    if (event.source !== frame.contentWindow) return
    onMessage(event.data ?? {})
  }
  window.addEventListener('message', listener)
  document.body.appendChild(frame)
  return {
    kind: 'iframe',
    post(message) { try { frame.contentWindow.postMessage(message, '*') } catch { /* not ready */ } },
    dispose() {
      try { window.removeEventListener('message', listener); frame.remove() } catch { /* already gone */ }
    },
  }
}

function inlineChannel({ sources, onMessage }) {
  void sources
  // Last resort. The dangerous globals are shadowed as parameters, so the
  // program cannot reach them by name even though it shares the page's realm.
  const shadow = [
    'window', 'self', 'globalThis', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket',
    'importScripts', 'setTimeout', 'setInterval', 'queueMicrotask', 'eval', 'parent', 'top',
  ]
  const runtime = createDilRuntime({ programKey: 'body', catalog: buildCatalog })
  return {
    kind: 'inline',
    post(message) {
      let result
      if (message.t === 'program') result = runtime.loadProgram(message)
      else if (message.t === 'event') result = runtime.dispatch(message)
      else if (message.t === 'rerender') result = runtime.settle(false)
      else return
      void shadow
      onMessage({ t: 'batch', nonce: message.nonce, firstRender: message.t === 'program', ...result })
    },
    dispose() { /* nothing to tear down */ },
  }
}

/* ------------------------------------------------------------------ *
 * Answers
 * ------------------------------------------------------------------ */

/** Control types whose current value is part of the card's answer. */
const VALUED = {
  slider: 'value', stepper: 'value', rating: 'value', segmented: 'value',
  radio: 'value', select: 'value', input: 'value', textarea: 'value',
  switch: 'checked', checkbox: 'checked',
}

/**
 * Walk the rendered tree and collect every named value.
 *
 * A control contributes under its `name`; the invisible `field` component
 * contributes a name/value pair directly, which is how composite components
 * make their selection part of the answer.
 */
export function collectAnswers(root) {
  const values = {}
  const seen = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    const valueProp = VALUED[node.type]
    if (valueProp !== undefined && typeof node.props.name === 'string') {
      values[node.props.name] = node.props[valueProp]
      if (!seen.includes(node.props.name)) seen.push(node.props.name)
    }
    if (node.type === 'field' && typeof node.props.name === 'string' && node.props.value !== undefined) {
      values[node.props.name] = node.props.value
      if (!seen.includes(node.props.name)) seen.push(node.props.name)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(root)
  return { values, order: seen, empty: seen.length === 0 }
}

/* ------------------------------------------------------------------ *
 * The card view
 * ------------------------------------------------------------------ */

/**
 * Build the two seats that carry one card.
 *
 * A card needs two homes because DSH's transcript has two policies at once:
 *
 *   * while the model is still writing the arguments, the turn is live and its
 *     tool row is on screen — so the tool row is where the interface can be
 *     watched growing;
 *   * once the turn closes, the standard transcript folds every tool call
 *     behind its completion disclosure, while `conversation.chat.turnTail` is a
 *     fold-independent seat by design.
 *
 * So the tool row streams the card, and the turn tail owns the settled,
 * always-visible one. Exactly one full card exists at a time: the row collapses
 * to a one-line receipt as soon as the call is dispatched.
 */
function createCardViews(deps) {
  const { React, renderers, sources } = deps

  /** The card body: sandbox, incremental compile, interaction, answer. */
  function CardBody(props) {
    const { argsText, submitAnswer, callId, live, asking } = props

    const args = React.useMemo(() => extractArgs(argsText), [argsText])
    const compiled = React.useMemo(() => {
      if (args.dil === '') return null
      try { return compileDil(args.dil) } catch { return null }
    }, [args.dil])

    const cardRef = React.useRef(null)
    if (cardRef.current === null) cardRef.current = createCard({ sources })
    const card = cardRef.current

    const [tree, setTree] = React.useState(null)
    React.useEffect(() => card.subscribe(setTree), [card])
    React.useEffect(() => () => card.dispose(), [card])

    const code = compiled === null ? '' : compiled.code
    React.useEffect(() => {
      if (code !== '') card.load({ code, constants: compiled.constants })
    }, [card, code])

    const [note, setNote] = React.useState('')
    const [status, setStatus] = React.useState('idle')

    const finish = React.useCallback(() => {
      const answers = collectAnswers(card.snapshot().root)
      if (answers.empty && note.trim() === '') return
      setStatus('sending')
      Promise.resolve(submitAnswer({
        callId,
        surface: args.surface,
        title: args.title,
        values: answers.values,
        order: answers.order,
        note: note.trim() === '' ? undefined : note.trim(),
      })).then(() => setStatus('sent')).catch(() => setStatus('failed'))
    }, [card, note, submitAnswer, callId, args.surface, args.title])

    const onCardClick = React.useCallback((event) => {
      const submit = event.target instanceof Element ? event.target.closest('[data-iui-submit]') : null
      if (submit === null) return
      event.preventDefault()
      finish()
    }, [finish])

    const diagnostics = compiled === null ? [] : compiled.diagnostics
    // The heading the model wrote is a better label than a generic one.
    const title = args.title ?? firstHeading(args.dil) ?? 'Interactive'

    return React.createElement('div', { className: 'iui-root', onClickCapture: onCardClick, 'data-live': live ? 'true' : undefined },
      React.createElement('div', { className: 'iui-head' },
        React.createElement('span', { className: 'iui-head-title' }, title),
        React.createElement('span', { className: 'iui-head-rule' }),
        live
          ? React.createElement('span', { className: 'iui-chip iui-live' },
              React.createElement('span', { className: 'iui-live-dot' }), 'writing')
          : null,
        diagnostics.length > 0
          ? React.createElement('span', { className: 'iui-chip', title: JSON.stringify(diagnostics) },
              `${diagnostics.length} adjusted`)
          : null),
      React.createElement('div', { className: 'iui-frame' },
        compiled === null
          ? React.createElement('div', { className: 'iui-wait' },
              React.createElement('div', { className: 'iui-wait-bar', style: { width: '62%' } }),
              React.createElement('div', { className: 'iui-wait-bar', style: { width: '88%' } }),
              React.createElement('div', { className: 'iui-wait-bar', style: { width: '44%' } }))
          : renderCard(React, renderers, tree)),
      tree !== null && tree.error !== null && tree.error !== undefined
        ? React.createElement('div', { className: 'iui-problem' }, String(tree.error.message ?? 'render failed'))
        : null,
      React.createElement(AnswerFooter, {
        React,
        GrowingTextarea: renderers.GrowingTextarea,
        args: asking === true ? { ...args, asking: true } : args,
        status,
        note,
        setNote,
        onSend: finish,
        // A card that already contains its own submit control keeps it, so the
        // footer does not add a second one; it still hosts the question and the
        // optional note.
        showSubmit: !hasSubmitControl(tree === null ? null : tree.root),
      }))
  }

  /**
   * The tool row.
   *
   * While the call is preparing, this is the live interface. After it has been
   * dispatched it collapses to a receipt, because the turn tail now owns the
   * card and two interactive copies of the same surface would drift apart.
   */
  function ToolCallCard(props) {
    // Provided by the Tool layer for every `tool.call.toolview` entry. It is a
    // real React hook (useSyncExternalStore inside) and this component does not
    // remount across phases, so it is called unconditionally; it returns "" once
    // the call has stopped preparing.
    const usePartial = props.useToolCallArgumentsPartial
    const partial = typeof usePartial === 'function' ? usePartial() : ''
    const argsText = rawArgumentsText(props.phase, props.block, partial)

    const asking = props.toolName === ASK_TOOL_NAME
    if (props.phase === 'preparing') {
      return React.createElement(CardBody, {
        argsText,
        submitAnswer: props.submitAnswer ?? NO_ANSWER,
        callId: props.callId,
        live: true,
        asking,
      })
    }
    return React.createElement(CardReceipt, { React, argsText })
  }

  /** One line naming the card, for the folded-away tool row. */
  function CardReceipt({ React: R, argsText }) {
    const args = R.useMemo(() => extractArgs(argsText), [argsText])
    const title = args.title ?? firstHeading(args.dil)
    if (title === null) return null
    return R.createElement('div', { className: 'iui-receipt' },
      R.createElement('span', { className: 'iui-receipt-mark' }, '▦'),
      R.createElement('span', { className: 'iui-receipt-title' }, title))
  }

  /**
   * The turn tail.
   *
   * `conversation.chat.turnTail` is a list entry rendered after a completed
   * turn, and its kind is fold-independent — which is what makes it the right
   * home for an answer that happens to be an interface.
   */
  function TurnTailCard(props) {
    // The owner hands over a `TurnLocation`, not the turn number; tolerating a
    // bare number keeps this working if the prop is ever narrowed.
    const turn = props.turn !== null && typeof props.turn === 'object' ? props.turn.turn : props.turn
    const call = useTurnCardCall(React, props.useChat, turn)
    if (call === null) return null
    return React.createElement(CardBody, {
      argsText: call.raw,
      submitAnswer: props.submitAnswer ?? NO_ANSWER,
      callId: undefined,
      live: false,
      asking: call.tool === ASK_TOOL_NAME,
    })
  }

  return { ToolCallCard, TurnTailCard }
}

/**
 * Whether a rendered tree already carries a submit control.
 *
 * Takes the tree's *root node* — the one the card's `latest` snapshot holds at
 * `.root` — not the snapshot wrapper.
 *
 * A model may write its own `<button submit/>`; a composite used to. Either way
 * the card must end up with exactly one way to answer.
 */
export function hasSubmitControl(rootNode) {
  if (rootNode === null || rootNode === undefined) return false
  const stack = [...(rootNode.children ?? [])]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || node === undefined) continue
    if (node.type === 'button' && node.props.submit === true) return true
    if (node.type === 'form' && node.props.submitLabel !== undefined) return true
    for (const child of node.children ?? []) stack.push(child)
  }
  return false
}

/** Used when no answer channel is available; the card still renders and runs. */
const NO_ANSWER = () => Promise.reject(new Error('intelligent-ui: no answer channel'))

/** The first Markdown heading of a document, as a fallback card label. */
function firstHeading(dil) {
  const match = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(String(dil ?? ''))
  if (match === null) return null
  const text = match[1].replace(/[*`]/g, '').trim()
  return text === '' ? null : text.slice(0, 80)
}

/**
 * Subscribe to one turn's tool calls and return the last card call in it, or
 * `null` when the turn rendered no card.
 */
function useTurnCardCall(React, useChat, turn) {
  const source = typeof useChat === 'function' && Number.isFinite(turn)
    ? useChat((snapshot) => snapshot.nodes.turnDataSource(turn, 'tool-call'))
    : null
  const subscribe = React.useCallback(
    (listener) => (source === null ? () => {} : source.subscribe(listener)),
    [source],
  )
  const getSnapshot = React.useCallback(
    () => (source === null ? EMPTY_CALLS : source.getSnapshot()),
    [source],
  )
  const calls = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return resolveCardCall(calls, CARD_TOOLS)
}

const EMPTY_CALLS = []

/**
 * The last card call in a turn.
 *
 * @param calls - `ToolChatData[]` for the turn, in anchor order.
 * @param toolNames - the wire names this plugin owns.
 * @returns `{ tool, raw }`, or `null` when the turn rendered no card.
 */
export function resolveCardCall(calls, toolNames = CARD_TOOLS) {
  if (!Array.isArray(calls)) return null
  const wanted = new Set(toolNames)
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const root = calls[i] === null || calls[i] === undefined ? undefined : calls[i].root
    if (root === null || root === undefined) continue
    // A dispatched call carries its identity on the call itself; a result
    // carries the call head under `call`, which is null when the log window
    // dropped the original.
    const head = root.call === null || root.call === undefined ? root : root.call
    if (!wanted.has(head.name)) continue
    if (typeof head.argsRaw === 'string' && head.argsRaw !== '') return { tool: head.name, raw: head.argsRaw }
  }
  return null
}

/** Render the decoded tree the reconciler produced. */
function renderCard(React, renderers, tree) {
  if (tree === null || tree.root === undefined) return null
  const scope = { render: (node) => renderers.renderNode(node, scope) }
  const children = (tree.root.children ?? []).map((node) => renderers.renderNode(node, scope))
  return React.createElement(React.Fragment, null, ...children)
}

/**
 * The note box and submit control.
 *
 * Only ever present for a mid-task clarification. A finished deliverable has no
 * business asking for feedback: the conversation already has an input box, and
 * the native one is better — it carries attachments, slash commands and the
 * prompt history. The host enforces this by not offering the answer contract on
 * the delivery tool at all, so this footer can only ever appear for a question.
 */
function AnswerFooter({ React, GrowingTextarea, args, status, note, setNote, onSend, showSubmit = true }) {
  if (!args.asking) return null
  if (status === 'sent') {
    return React.createElement('div', { className: 'iui-sent' }, '✓ 已发送给模型')
  }
  const allowNote = args.allowNote !== false
  return React.createElement('div', { className: 'iui-foot' },
    args.prompt !== undefined ? React.createElement('div', { className: 'iui-foot-hint' }, args.prompt) : null,
    allowNote
      ? React.createElement(GrowingTextarea, {
          className: 'iui-foot-note',
          value: note,
          minRows: 2,
          maxRows: 6,
          placeholder: args.notePlaceholder ?? '补充说明（可选）',
          onValue: setNote,
          style: { fontSize: '13px' },
        })
      : null,
    React.createElement('div', { className: 'iui-foot-row' },
      status === 'failed' ? React.createElement('span', { className: 'iui-foot-hint' }, '发送失败，请重试') : null,
      status === 'sending' ? React.createElement('span', { className: 'iui-foot-hint' }, '发送中…') : null,
      showSubmit
        ? React.createElement('button', {
            className: 'iui-send',
            type: 'button',
            'data-iui-submit': 'true',
            disabled: status === 'sending',
            onClick: onSend,
          }, args.submitLabel ?? '提交')
        : null))
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

/**
 * Mount the card chrome for exactly the owning plugin's lifetime.
 *
 * `data-plugin` is what the module system matches when it drains a replaced
 * bundle, and the `ctx.effect` disposer covers an ordinary disable, which does
 * not go through that path.
 */
function installStyles(ctx) {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_NAME
    tag.dataset.pluginCss = `${PLUGIN_NAME}/card.css`
    tag.textContent = CARD_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, `${PLUGIN_NAME}: card chrome`)
}

/**
 * Turn one card answer into the text of the user's next message.
 *
 * The card does not invent a new RPC: the answer rides the ordinary user
 * message channel, so it is durable in the session log and the model simply
 * reads it as the next turn's prompt.
 */
export function answerMessage(payload) {
  const { values, order, note, title, callId } = payload
  const lines = (order ?? []).length === 0
    ? ['- (no named values)']
    : order.map((name) => `- ${name}: ${formatValue(values[name])}`)
  return [
    `[Intelligent UI] ${title ?? 'Card'} — the user answered the card you rendered${callId === undefined ? '' : ` (call ${callId})`}.`,
    '',
    ...lines,
    note === undefined ? '' : `- note: ${note}`,
  ].filter((line) => line !== '').join('\n')
}

export function createClientPlugin(deps) {
  const React = deps.React
  if (deps.sources === undefined) throw new Error('intelligent-ui: runner sources missing')
  const renderers = createRenderers(React)
  const views = createCardViews({ React, renderers, sources: deps.sources })

  /**
   * The only bridge from a component to `ctx`: a session-scoped inject face,
   * built once per (entry x session binding) and memoized by the renderer.
   */
  const answerFace = (ctx) => (sessionId) => ({
    async submitAnswer(payload) {
      const text = answerMessage(payload)
      const sessions = ctx.get('sessions')
      const binding = sessions === undefined || sessions === null ? undefined : sessions.binding(sessionId)
      if (binding !== undefined && binding !== null) {
        const result = await binding.session.prompt([{ type: 'text', text }], 'steer')
        if (result !== undefined && result.ok === false) {
          throw new Error(`intelligent-ui: answer rejected (${result.error?.code ?? 'unknown'})`)
        }
        return
      }
      const scoped = sessions === undefined || sessions === null ? undefined : sessions.scope(sessionId)
      if (scoped !== undefined && scoped !== null) return scoped.conversation.send(text)
      throw new Error(`intelligent-ui: session "${String(sessionId)}" is not open in this page`)
    },
  })

  return {
    inject: ['slots', 'sessions'],
    apply(ctx) {
      installStyles(ctx)

      ctx.slots.inject('tool.call.toolview', function* () {
        // One registration per wire name. A generator return installs them
        // together and rolls them back together.
        for (const key of CARD_TOOLS) {
          yield ctx.slots.register({
            name: 'tool.call.toolview',
            key,
            registrant: `${PLUGIN_NAME}:${key}`,
            inject: answerFace(ctx),
          }, views.ToolCallCard)
        }
      })

      // The fold-independent seat: the card stays visible even when the
      // transcript collapses every tool call behind the turn's disclosure.
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'intelligent-ui-card',
        order: 40,
        registrant: PLUGIN_NAME,
        inject: answerFace(ctx),
      }, views.TurnTailCard))
    },
  }
}

function formatValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

export { CARD_CSS }
