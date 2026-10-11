/**
 * Intelligent UI — the sandboxed client runtime.
 *
 * The compiled program is model-written code, so it never runs in the page. A
 * Worker (created from a Blob URL, its global scope stripped before the first
 * program runs) evaluates the program and produces **operations**; the page
 * applies those operations to its own component tree.
 *
 * This module is the evaluator half:
 *
 *   * **lockdown** — network, timers, dynamic code evaluation and messaging are
 *     removed from the worker global before the first program runs, and the
 *     runtime objects are frozen;
 *   * **evaluation** — the program is evaluated once with `new Function`,
 *     receiving `DIL`, `__dil` and `GenUI` as parameters;
 *   * **reconciler** — a small keyed reconciler keeps hook state in absolute
 *     keyed slots, compares the new tree with the previous one and encodes the
 *     differences as operations. It does not draw anything;
 *   * **watchdog** — a program that does not answer in time is quarantined by
 *     the page and the Worker is restarted.
 *
 * Functions never leave the worker: a handler is sent only as an identifier
 * (`fn#1`), and the page sends that identifier back when the user interacts.
 *
 * @module intelligent-ui/src/runtime/runtime
 */

/** Operation opcodes: one line per node op on the wire. */
export const OP = Object.freeze({
  CREATE: 0,
  SET: 1,
  TEXT: 2,
  PLACE: 3,
  REMOVE: 4,
})

/** Value tags for the per-batch string/primitive table. */
export const VAL = Object.freeze({
  VOID: 0,
  NUMBER: 1,
  BOOLEAN: 2,
  STRING: 3,
  JSON: 4,
  HANDLER: 5,
})

/** The transparent container the compiler emits as `__dil.Fragment`. */
export const FRAGMENT = Symbol.for('intelligent-ui.fragment')

/** Root container id; every op addresses nodes below it. */
export const ROOT_ID = 0

/** How many cascaded re-renders one interaction may trigger before we stop. */
const MAX_SETTLE_PASSES = 32

/**
 * The one reference to dynamic evaluation.
 *
 * It is captured while the module is evaluated, which happens before lockdown
 * removes `Function` from the runner's global scope. That is what lets the
 * loader compile a program once and the program itself never compile anything.
 */
const DIL_COMPILE = typeof Function === 'function' ? Function : null

/** Collect strings for one batch so the wire stays a table plus integers. */
class StringTable {
  constructor() {
    this.values = []
    this.index = new Map()
  }

  add(value) {
    const text = String(value)
    const existing = this.index.get(text)
    if (existing !== undefined) return existing
    const key = this.values.length
    this.values.push(text)
    this.index.set(text, key)
    return key
  }
}

/** Encode one property value into the `[tag, payload]` wire form. */
function encodeValue(value, strings, handlerIds) {
  if (value === null || value === undefined) return [VAL.VOID, 0]
  if (typeof value === 'number') return [VAL.NUMBER, Number.isFinite(value) ? value : 0]
  if (typeof value === 'boolean') return [VAL.BOOLEAN, value ? 1 : 0]
  if (typeof value === 'string') return [VAL.STRING, strings.add(value)]
  if (typeof value === 'function') return [VAL.HANDLER, handlerIds(value)]
  try {
    return [VAL.JSON, strings.add(JSON.stringify(value) ?? 'null')]
  } catch {
    return [VAL.VOID, 0]
  }
}

/**
 * Decode one `[tag, payload]` pair back into a JavaScript value.
 * @param strings - the batch's string table.
 * @param handlers - optional `(id) => fn` resolver so a page-side handler prop
 *   becomes a real callable that posts an interaction back to the worker.
 */
export function decodeValue(encoded, strings, handlers) {
  if (encoded === undefined || encoded === null) return undefined
  const tag = encoded[0]
  const payload = encoded[1]
  switch (tag) {
    case VAL.NUMBER: return payload
    case VAL.BOOLEAN: return payload === 1
    case VAL.STRING: return strings[payload]
    case VAL.JSON:
      try { return JSON.parse(strings[payload]) } catch { return undefined }
    case VAL.HANDLER: return handlers === undefined ? undefined : handlers(payload)
    default: return undefined
  }
}

/**
 * Decode one operation batch into `{ type, props, children, text }` records
 * keyed by node id, and return the root id.
 *
 * The page owns the resulting tree; the runtime never draws.
 */
export function decodeTree(batch, options = {}) {
  const nodeMap = options.nodes ?? new Map()
  const strings = batch.strings ?? []
  const root = options.root ?? null
  const onHandler = options.onHandler
  const resolve = onHandler === undefined ? undefined : (id) => onHandler(id)
  const parentOf = (id) => (id === ROOT_ID ? root : nodeMap.get(id))

  const detach = (node) => {
    const parent = node.parent === undefined ? undefined : parentOf(node.parent)
    if (parent === undefined || parent === null) return
    const order = parent.childrenOrder ?? (parent.childrenOrder = [])
    const at = order.indexOf(node.id)
    if (at !== -1) order.splice(at, 1)
  }

  for (const op of batch.ops ?? []) {
    switch (op[0]) {
      case OP.CREATE:
        nodeMap.set(op[1], {
          id: op[1], type: strings[op[2]], props: {}, children: [],
          childrenOrder: [], parent: ROOT_ID, index: 0, text: null,
        })
        break
      case OP.SET: {
        const node = nodeMap.get(op[1])
        if (node === undefined) break
        const name = strings[op[2]]
        const value = decodeValue(op[3], strings, resolve)
        if (value === undefined && op[3][0] === VAL.VOID) delete node.props[name]
        else node.props[name] = value
        break
      }
      case OP.TEXT: {
        const node = nodeMap.get(op[1])
        if (node !== undefined) node.text = strings[op[2]]
        break
      }
      case OP.PLACE: {
        const node = nodeMap.get(op[1])
        if (node === undefined) break
        detach(node)
        node.parent = op[2]
        node.index = op[3]
        const parent = parentOf(op[2])
        if (parent !== undefined && parent !== null) {
          const order = parent.childrenOrder ?? (parent.childrenOrder = [])
          order.splice(Math.max(0, Math.min(op[3], order.length)), 0, node.id)
        }
        break
      }
      case OP.REMOVE: {
        const stack = [op[1]]
        while (stack.length > 0) {
          const id = stack.pop()
          const node = nodeMap.get(id)
          if (node === undefined) continue
          detach(node)
          for (const child of node.childrenOrder ?? []) stack.push(child)
          nodeMap.delete(id)
        }
        break
      }
      default:
        break
    }
  }

  for (const node of nodeMap.values()) {
    node.children = (node.childrenOrder ?? []).map((id) => nodeMap.get(id)).filter(Boolean)
  }
  if (root !== null) {
    root.children = (root.childrenOrder ?? []).map((id) => nodeMap.get(id)).filter(Boolean)
  }
  return nodeMap
}

/* ------------------------------------------------------------------ *
 * The evaluator
 * ------------------------------------------------------------------ */

const NO_PROPS = Object.freeze({})

/**
 * Build the runtime that a worker (or the inline fallback) drives.
 *
 * @param options - `{ programKey: string }`.
 */
export function createDilRuntime(options = {}) {
  const programKey = options.programKey ?? 'body'

  /** Absolute-keyed hook slots, so state survives every recompilation. */
  const slots = new Map()
  /** Stable handler identifiers; a function keeps its id for the runtime's life. */
  const handlerIdByFn = new Map()
  const fnByHandlerId = new Map()
  const nodes = new Map()

  let constants = {}
  let appData = {}
  let program = null
  let renderRoot = null
  let previousTree = null
  let nextNodeId = 1
  let nextHandlerId = 1
  let hookCursor = 0
  let dirty = false
  let generation = 0
  let lastError = null

  const pendingEffects = []
  const collectHandler = (fn) => {
    let id = handlerIdByFn.get(fn)
    if (id === undefined) {
      id = nextHandlerId
      nextHandlerId += 1
      handlerIdByFn.set(fn, id)
      fnByHandlerId.set(id, fn)
    }
    return id
  }

  /* ---- hooks ---- */

  function slotAt(explicitKey, position) {
    const key = explicitKey !== undefined && explicitKey !== null
      ? `@${explicitKey}`
      : `#${programKey}:${position}`
    let slot = slots.get(key)
    if (slot === undefined) {
      slot = { key, value: undefined, initialised: false, deps: undefined, set: null }
      slots.set(key, slot)
    }
    return slot
  }

  function sameDeps(previous, next) {
    if (!Array.isArray(previous) || !Array.isArray(next)) return false
    if (previous.length !== next.length) return false
    for (let i = 0; i < previous.length; i += 1) if (!Object.is(previous[i], next[i])) return false
    return true
  }

  /** The JSX factory the compiled program calls. */
  const jsx = (type, props, ...children) => {
    const flat = children.length === 0 ? [] : flatten(children)
    return { type, props: props ?? NO_PROPS, children: flat }
  }

  function flatten(list, out = []) {
    for (const item of list) {
      if (Array.isArray(item)) { flatten(item, out); continue }
      if (item === null || item === undefined || typeof item === 'boolean') continue
      if (typeof item === 'string' || typeof item === 'number') { out.push(String(item)); continue }
      out.push(item)
    }
    return out
  }

  const DIL = {
    /** The compiled program's single call: hand over the element to reconcile. */
    render(element) {
      renderRoot = element
    },

    /** Element factory, for building dynamic lists with `.map(...)`. */
    h: jsx,

    /** The transparent container, for grouping without adding a box. */
    Fragment: FRAGMENT,

    useState(initial, hookOptions) {
      const slot = slotAt(hookOptions?.key, hookCursor)
      hookCursor += 1
      if (!slot.initialised) {
        slot.value = typeof initial === 'function' ? initial() : initial
        slot.initialised = true
      }
      if (slot.set === null) {
        // One setter per slot, so handler identity is stable across renders.
        slot.set = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (Object.is(value, slot.value)) return
          slot.value = value
          dirty = true
        }
      }
      return [slot.value, slot.set]
    },

    useReducer(reducer, initial, hookOptions) {
      const [state, setState] = DIL.useState(initial, hookOptions)
      return [state, (action) => setState((current) => reducer(current, action))]
    },

    useMemo(compute, deps) {
      const slot = slotAt(undefined, hookCursor)
      hookCursor += 1
      if (!slot.initialised || !sameDeps(slot.deps, deps)) {
        slot.value = compute()
        slot.deps = Array.isArray(deps) ? deps.slice() : deps
        slot.initialised = true
      }
      return slot.value
    },

    useCallback(fn, deps) {
      return DIL.useMemo(() => fn, deps)
    },

    useRef(initial) {
      const slot = slotAt(undefined, hookCursor)
      hookCursor += 1
      if (!slot.initialised) {
        slot.value = { current: initial }
        slot.initialised = true
      }
      return slot.value
    },

    useEffect(effect, deps) {
      const slot = slotAt(undefined, hookCursor)
      hookCursor += 1
      if (!slot.initialised || !sameDeps(slot.deps, deps)) {
        slot.deps = Array.isArray(deps) ? deps.slice() : deps
        slot.initialised = true
        pendingEffects.push(effect)
      }
    },

    useConstants() {
      return constants
    },

    useAppData(selector) {
      if (typeof selector !== 'function') return appData
      try { return selector(appData) } catch { return undefined }
    },
  }

  const __dil = Object.freeze({ jsx, Fragment: FRAGMENT })

  /**
   * Composite components, built *inside* this runtime so their functions never
   * have to cross a realm boundary. The factory is called here rather than at
   * module scope because it needs this instance's `__dil` and `DIL`.
   */
  const composites = typeof options.catalog === 'function'
    ? options.catalog({ __dil, DIL })
    : (options.catalog ?? {})

  /* ---- program loading ---- */

  /**
   * Evaluate one compiled program.
   *
   * A program that fails to evaluate or render leaves the previous one in
   * place and returns `{ ok: false }`: the last program that worked stays on
   * screen. Hook values are snapshotted and restored on failure so a partial
   * render cannot corrupt state.
   */
  function loadProgram(input) {
    const previous = { constants, appData }
    const snapshot = new Map()
    for (const [key, slot] of slots) snapshot.set(key, slot.value)
    try {
      // The one and only use of dynamic evaluation. `Function` is captured at
      // module scope before lockdown deletes it from the runner global.
      if (DIL_COMPILE === null) throw new Error('no dynamic evaluation available')
      const compiled = DIL_COMPILE('__dil', 'DIL', 'GenUI', input.code)
      constants = Object.freeze({ ...(input.constants ?? {}) })
      appData = input.appData ?? {}

      renderRoot = null
      hookCursor = 0
      pendingEffects.length = 0
      compiled(__dil, DIL, composites)
      if (renderRoot === null) throw new Error('program did not call DIL.render')

      program = compiled
      lastError = null
      return settle(true)
    } catch (error) {
      constants = previous.constants
      appData = previous.appData
      for (const [key, value] of snapshot) {
        const slot = slots.get(key)
        if (slot !== undefined) slot.value = value
      }
      lastError = describeError(error)
      return { ok: false, error: lastError, generation }
    }
  }

  /**
   * Deliver one page-side interaction to the handler that produced it.
   * No model call is involved: the handler runs here, state updates, and the
   * differences come back as operations.
   */
  function dispatch(payload) {
    const fn = fnByHandlerId.get(payload.handler)
    if (typeof fn !== 'function') {
      return { ok: false, error: { name: 'Error', message: `unknown handler fn#${payload.handler}` }, generation }
    }
    try {
      fn(...(Array.isArray(payload.args) ? payload.args : [payload.args]))
    } catch (error) {
      lastError = describeError(error)
      return { ok: false, error: lastError, generation }
    }
    return settle(false)
  }

  /**
   * Render until the tree stops asking to render again, then encode one batch.
   *
   * Every pass shares one string table and one operation log, so a cascaded
   * update (an effect that sets state) rides the same wire message as the
   * interaction that caused it.
   *
   * @param asFirstRender - clear the tree so the page rebuilds from scratch.
   */
  function settle(asFirstRender) {
    const strings = new StringTable()
    const ops = []
    let first = renderInto(asFirstRender, strings, ops)
    if (!first.ok) return { ...first, generation }
    let passes = 0
    while (dirty && passes < MAX_SETTLE_PASSES) {
      dirty = false
      passes += 1
      const previousTreeSnapshot = previousTree
      const next = renderInto(false, strings, ops)
      if (!next.ok) {
        // A failed cascaded pass rolls the tree back to the last good shape.
        previousTree = previousTreeSnapshot
        break
      }
    }
    dirty = false
    return { ok: true, generation, ops, strings: strings.values, stats: stats(), passes }
  }

  /** Evaluate the program once and diff its output into `ops`. */
  function renderInto(asFirstRender, strings, ops) {
    if (program === null) {
      return { ok: false, error: { name: 'Error', message: 'no program loaded' } }
    }
    try {
      renderRoot = null
      hookCursor = 0
      pendingEffects.length = 0
      program(__dil, DIL, composites)
    } catch (error) {
      lastError = describeError(error)
      return { ok: false, error: lastError }
    }
    try {
      encodeTree(asFirstRender, strings, ops)
    } catch (error) {
      lastError = describeError(error)
      return { ok: false, error: lastError }
    }
    return { ok: true }
  }

  /** Walk the rendered element tree into plain descriptors and diff it. */
  function encodeTree(asFirstRender, strings, ops) {
    const element = renderRoot
    const tree = element === null ? null : walk(element, 0)

    if (asFirstRender) {
      generation += 1
      nodes.clear()
      previousTree = null
    }
    if (tree === null) {
      previousTree = null
      return
    }

    const rootDescriptor = { type: '#root', props: NO_PROPS, children: tree.type === '#fragment' ? tree.children : [tree] }
    previousTree = diffNode(previousTree, rootDescriptor, ROOT_ID, 0, ops, strings)

    for (const effect of pendingEffects.splice(0)) {
      try { effect() } catch { /* an effect failure must not break the render */ }
    }
  }

  function stats() {
    return { nodes: nodes.size, hooks: slots.size, handlers: fnByHandlerId.size }
  }

  /**
   * Walk the rendered element tree into descriptors, expanding function
   * components (the body root, and every composite) and substituting a visible
   * placeholder for anything the catalog does not know.
   */
  function walk(element, depth) {
    if (element === null || element === undefined) return null
    if (typeof element === 'string') return { type: '#text', props: NO_PROPS, children: [], text: element }
    if (typeof element === 'number') return { type: '#text', props: NO_PROPS, children: [], text: String(element) }
    if (depth > 64) return { type: '#unsupported', props: { why: 'nesting-too-deep' }, children: [], text: null }

    const { type, props, children } = element
    if (type === FRAGMENT) {
      const inner = flatten(children.map((child) => walk(child, depth + 1)).filter((child) => child !== null))
      return { type: '#fragment', props: NO_PROPS, children: inner, text: null }
    }
    if (typeof type === 'function') {
      let produced
      try {
        produced = type({ ...props, children })
      } catch (error) {
        return { type: '#error', props: { message: describeError(error).message }, children: [], text: null }
      }
      return walk(produced, depth + 1)
    }
    if (typeof type !== 'string') {
      return { type: '#unsupported', props: { why: String(type) }, children: [], text: null }
    }

    const composite = composites[type]
    if (typeof composite === 'function') {
      let produced
      // Composites are pure: their hook reads must not perturb the body's
      // positional hook cursor.
      const savedCursor = hookCursor
      try {
        produced = composite({ ...props, children })
      } catch (error) {
        return { type: '#error', props: { message: describeError(error).message, component: type }, children: [], text: null }
      } finally {
        hookCursor = savedCursor
      }
      return walk(produced, depth + 1)
    }

    const walked = flatten(children.map((child) => walk(child, depth + 1)).filter((child) => child !== null))
    return { type, props, children: walked, text: null }
  }

  /**
   * Diff one node against its previous incarnation and append operations.
   * @returns the descriptor the next diff matches on.
   */
  function diffNode(previous, next, parentId, index, ops, strings) {
    const reusable = previous !== null && previous !== undefined && previous.type === next.type
    let id
    if (reusable) {
      id = previous.id
    } else {
      if (previous !== null && previous !== undefined) ops.push([OP.REMOVE, previous.id])
      id = nextNodeId
      nextNodeId += 1
      ops.push([OP.CREATE, id, strings.add(next.type)])
      ops.push([OP.PLACE, id, parentId, index])
    }

    if (next.type === '#text') {
      if (!reusable || previous.text !== next.text) ops.push([OP.TEXT, id, strings.add(next.text ?? '')])
      const descriptor = { id, type: next.type, props: NO_PROPS, children: [], text: next.text }
      nodes.set(id, descriptor)
      return descriptor
    }

    if (next.type === '#error') {
      if (!reusable || previous.props.message !== next.props.message) {
        ops.push([OP.SET, id, strings.add('message'), encodeValue(next.props.message, strings, collectHandler)])
      }
      const descriptor = { id, type: next.type, props: next.props, children: [], text: null }
      nodes.set(id, descriptor)
      return descriptor
    }

    const previousProps = reusable ? previous.props : NO_PROPS
    for (const [name, value] of Object.entries(next.props)) {
      if (name === 'children') continue
      if (reusable && sameValue(previousProps[name], value)) continue
      ops.push([OP.SET, id, strings.add(name), encodeValue(value, strings, collectHandler)])
    }
    if (reusable) {
      for (const name of Object.keys(previousProps)) {
        if (name === 'children') continue
        if (!Object.prototype.hasOwnProperty.call(next.props, name)) {
          ops.push([OP.SET, id, strings.add(name), [VAL.VOID, 0]])
        }
      }
    }

    const previousChildren = reusable ? previous.children ?? [] : []
    const byKey = new Map()
    const leftovers = []
    for (const child of previousChildren) {
      const key = childKey(child)
      if (key !== null && !byKey.has(key)) byKey.set(key, child)
      else leftovers.push(child)
    }

    const used = new Set()
    const nextChildren = []
    let position = 0
    let leftoverCursor = 0
    for (const child of next.children) {
      const key = childKey(child)
      let match = null
      if (key !== null && byKey.has(key) && !used.has(byKey.get(key))) {
        match = byKey.get(key)
      } else {
        while (leftoverCursor < leftovers.length && used.has(leftovers[leftoverCursor])) leftoverCursor += 1
        const candidate = leftovers[leftoverCursor]
        if (candidate !== undefined && candidate.type === child.type) {
          match = candidate
          leftoverCursor += 1
        }
      }
      if (match !== null) used.add(match)
      const descriptor = diffNode(match, child, id, position, ops, strings)
      if (match !== null && previousChildren.indexOf(match) !== position) {
        ops.push([OP.PLACE, descriptor.id, id, position])
      }
      nextChildren.push(descriptor)
      position += 1
    }

    for (const child of previousChildren) {
      if (!used.has(child)) ops.push([OP.REMOVE, child.id])
    }

    const descriptor = { id, type: next.type, props: next.props, children: nextChildren, text: null }
    nodes.set(id, descriptor)
    return descriptor
  }

  function childKey(child) {
    const key = child.props?.key
    return key === undefined || key === null ? null : `k:${String(key)}`
  }

  function sameValue(left, right) {
    if (Object.is(left, right)) return true
    if (typeof left === 'function' || typeof right === 'function') return false
    if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
      try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
    }
    return false
  }

  function describeError(error) {
    if (error instanceof Error) return { name: error.name, message: error.message }
    return { name: 'Error', message: String(error) }
  }

  return {
    loadProgram,
    dispatch,
    describeError,
    settle,
    /** @returns a batch only when a render was actually pending. */
    tick() {
      if (!dirty) return null
      dirty = false
      const batch = settle(false)
      return batch.ok ? batch : null
    },
    get generation() { return generation },
    get lastError() { return lastError },
    get nodeCount() { return nodes.size },
    get hookCount() { return slots.size },
  }
}

/* ------------------------------------------------------------------ *
 * Runner source, assembled by the build step
 * ------------------------------------------------------------------ */

/**
 * The body of the Worker.
 *
 * `deps` supplies the three modules the runner needs, already flattened to
 * source text, so the build ships one self-contained blob without a bundler
 * resolving module edges at runtime.
 */
export function workerSource(deps) {
  return [
    '/* Intelligent UI runner. Model-written programs are evaluated here and never in the page. */',
    deps.catalog,
    deps.compile,
    deps.composite,
    deps.runtime,
    deps.lockdown,
    'const __dilRuntime = createDilRuntime({ programKey: "body", catalog: (api) => buildComposites(api) })',
    '/* Captured before lockdown removes messaging from the runner global. */',
    'const __dilPost = self.postMessage.bind(self)',
    'const __dilSend = (message) => { try { __dilPost(message) } catch { /* channel closed */ } }',
    'const __dilProgram = Function',
    'void __dilProgram',
    `self.onmessage = (event) => {
  const message = event.data || {}
  try {
    if (message.t === 'lockdown') { __dilSend({ t: 'locked', nonce: message.nonce, removed: __dilLockdown() }); return }
    if (message.t === 'program') { const result = __dilRuntime.loadProgram(message); __dilSend({ t: 'batch', nonce: message.nonce, firstRender: true, ...result }); return }
    if (message.t === 'event') { const result = __dilRuntime.dispatch(message); __dilSend({ t: 'batch', nonce: message.nonce, ...result }); return }
    if (message.t === 'rerender') { const result = __dilRuntime.settle(false); __dilSend({ t: 'batch', nonce: message.nonce, ...result }); return }
    if (message.t === 'ping') { __dilSend({ t: 'pong', nonce: message.nonce }); return }
    __dilSend({ t: 'error', nonce: message.nonce, error: { name: 'Error', message: 'unknown message ' + message.t } })
  } catch (error) {
    __dilSend({ t: 'error', nonce: message.nonce, error: __dilRuntime.describeError(error) })
  }
}`,
  ].join('\n;\n')
}

/**
 * Everything the runner global gives up before the first program runs.
 *
 * The article's runner "removes network access, timers, messaging and dynamic
 * code evaluation from its global scope, and freezes the remaining globals".
 * `postMessage` is captured first so the runtime keeps its own channel, and
 * `Function` is captured so the loader can compile the program once.
 */
export function lockdownSource() {
  return `function __dilLockdown() {
  const removed = []
  const names = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'postMessage',
    'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame',
    'caches', 'indexedDB', 'Worker', 'SharedWorker', 'MessageChannel',
    'BroadcastChannel', 'WebAssembly', 'navigator', 'location', 'eval', 'Function',
  ]
  for (const name of names) {
    try {
      if (name in self) { delete self[name]; removed.push(name) }
      else if (name in globalThis) { delete globalThis[name]; removed.push(name) }
    } catch { /* non-configurable: unreachable either way */ }
  }
  return removed
}`
}
