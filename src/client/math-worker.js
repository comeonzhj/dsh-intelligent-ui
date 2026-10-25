/** Bounded, cancellable formula rendering, separate from the DIL Worker. */
import { mathInputError, mathMarkupError } from './math.js'

export const MATH_TIMEOUT_MS = 1000
export const MAX_PENDING_MATH = 32

function createFormulaWorker() {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') || typeof __IUI_MATH_WORKER_SOURCE !== 'string') {
    throw new Error('The formula Worker is unavailable.')
  }
  const url = URL.createObjectURL(new Blob([__IUI_MATH_WORKER_SOURCE], { type: 'text/javascript' }))
  try {
    return new Worker(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** One live Worker at most; no idle Worker or unbounded queue survives a card. */
export function createMathService({ workerFactory = createFormulaWorker, timeoutMs = MATH_TIMEOUT_MS, maxPending = MAX_PENDING_MATH } = {}) {
  let worker = null
  let active = null
  let timer = null
  let nextId = 0
  let disposed = false
  const queue = []
  const failure = (error) => ({ markup: null, error })

  function stopWorker() {
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (worker !== null) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null
      worker.terminate()
      worker = null
    }
  }

  function settle(job, result) {
    job.signal?.removeEventListener('abort', job.abort)
    job.resolve(result)
  }

  function finish(result, reset = false) {
    const job = active
    if (job === null) return
    active = null
    if (timer !== null) { clearTimeout(timer); timer = null }
    if (reset) stopWorker()
    settle(job, result)
    pump()
  }

  function pump() {
    if (active !== null) return
    const job = queue.shift()
    if (job === undefined) { stopWorker(); return }
    active = job
    try {
      if (worker === null) {
        worker = workerFactory()
        worker.onmessage = ({ data }) => {
          if (active === null || data?.id !== active.id) return
          const result = data.result
          if (typeof result?.error === 'string') finish(failure(result.error.slice(0, 240)))
          else if (result?.error === null) {
            const error = mathMarkupError(result.markup)
            finish(error === null ? { markup: result.markup, error: null } : failure(error))
          } else finish(failure('Invalid formula Worker response.'), true)
        }
        worker.onerror = (event) => {
          event?.preventDefault?.()
          finish(failure('The formula Worker failed.'), true)
        }
        worker.onmessageerror = () => finish(failure('Invalid formula Worker response.'), true)
      }
      timer = setTimeout(() => finish(failure('Formula rendering timed out.'), true), timeoutMs)
      worker.postMessage({ id: job.id, tex: job.tex, display: job.display })
    } catch {
      finish(failure('The formula Worker is unavailable.'), true)
    }
  }

  function render(tex, display = false, signal) {
    const error = mathInputError(tex)
    if (error !== null) return Promise.resolve(failure(error))
    if (tex.trim() === '') return Promise.resolve({ markup: '', error: null })
    if (disposed) return Promise.resolve(failure('The formula renderer was disposed.'))
    if (signal?.aborted) return Promise.resolve(failure('Formula rendering cancelled.'))
    if (queue.length + (active === null ? 0 : 1) >= maxPending) return Promise.resolve(failure('Too many formulas are pending.'))
    return new Promise((resolve) => {
      const job = { id: ++nextId, tex, display: display === true, signal, resolve, abort: null }
      job.abort = () => {
        if (active === job) finish(failure('Formula rendering cancelled.'), true)
        else {
          const index = queue.indexOf(job)
          if (index !== -1) { queue.splice(index, 1); settle(job, failure('Formula rendering cancelled.')) }
        }
      }
      signal?.addEventListener('abort', job.abort, { once: true })
      queue.push(job)
      pump()
    })
  }

  function dispose() {
    disposed = true
    stopWorker()
    if (active !== null) { settle(active, failure('The formula renderer was disposed.')); active = null }
    while (queue.length > 0) settle(queue.shift(), failure('The formula renderer was disposed.'))
  }

  return { render, dispose }
}

const formulaService = createMathService()
export function renderMathIsolated(tex, display = false, signal) {
  return formulaService.render(tex, display, signal)
}
