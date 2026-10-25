/** Exercise the real vendored engine and the formula renderer, without a DOM. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { Worker as ThreadWorker } from 'node:worker_threads'

import { renderMath, MAX_MATH_LENGTH, MAX_MATH_MARKUP_LENGTH, MAX_MATH_ELEMENTS } from '../src/client/math.js'
import { createMathService } from '../src/client/math-worker.js'
import { compileDil } from '../lib/compile.js'
import { promptSectionText } from '../lib/prompt.js'
import { createDilRuntime, decodeTree, ROOT_ID } from '../src/runtime/runtime.js'

const vendor = await readFile(new URL('../vendor/katex.min.js', import.meta.url), 'utf8')
const katexModule = { exports: {} }
vm.runInNewContext(vendor, { module: katexModule, exports: katexModule.exports }, { timeout: 1000 })
const katex = katexModule.exports

for (const [name, tex, element] of [
  ['fraction', String.raw`\frac{1}{2}`, 'mfrac'],
  ['square root', String.raw`\sqrt{x^2+1}`, 'msqrt'],
  ['subscript and superscript', 'x_i^2', 'msubsup'],
  ['sum', String.raw`\sum_{i=1}^n i`, 'munderover'],
  ['integral', String.raw`\int_0^1 x\,dx`, 'msubsup'],
  ['matrix', String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, 'mtable'],
  ['aligned equations', String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`, 'mtable'],
]) {
  test(`vendored KaTeX renders a ${name} offline`, () => {
    const result = renderMath(tex, true, katex)
    assert.equal(result.error, null)
    assert.match(result.markup, new RegExp(`<${element}[ >]`))
    assert.match(result.markup, /<math[^>]*xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"/)
    assert.match(result.markup, /display="block"/)
    assert.doesNotMatch(result.markup, /katex-html|<script|<link|<img|@font-face/)
  })
}

test('inline mode has no block math and the engine version is pinned', () => {
  assert.equal(katex.version, '0.19.1')
  const result = renderMath('x^2', false, katex)
  assert.equal(result.error, null)
  assert.doesNotMatch(result.markup, /display="block"/)
})

test('every render fixes security options and uses a fresh macro scope', () => {
  const calls = []
  const runtime = { renderToString: (tex, options) => { calls.push({ tex, options }); return '<math/>' } }
  renderMath('x', false, runtime)
  renderMath('y', true, runtime)
  assert.equal(calls[0].options.output, 'mathml')
  assert.equal(calls[0].options.trust, false)
  assert.equal(calls[0].options.throwOnError, true)
  assert.equal(calls[0].options.maxExpand, 1000)
  assert.equal(calls[0].options.maxSize, 10)
  assert.equal(calls[0].options.displayMode, false)
  assert.equal(calls[1].options.displayMode, true)
  assert.notEqual(calls[0].options.macros, calls[1].options.macros)
})

test('missing, non-string and oversized input never reaches KaTeX', () => {
  const runtime = { renderToString: () => { throw new Error('must not be called') } }
  for (const tex of [undefined, null, 12, {}, 'x'.repeat(MAX_MATH_LENGTH + 1)]) {
    const result = renderMath(tex, false, runtime)
    assert.equal(result.markup, null)
    assert.equal(typeof result.error, 'string')
    assert.doesNotMatch(result.error, /must not be called/)
  }
  assert.deepEqual(renderMath('  ', false, runtime), { markup: '', error: null })
  assert.match(renderMath('x', false, null).error, /unavailable/)
})

test('malformed, unsupported and recursive input fails locally', () => {
  for (const tex of [String.raw`\frac{1}{`, String.raw`\notARealCommand{x}`, String.raw`\def\loop{\loop}\loop`]) {
    const result = renderMath(tex, false, katex)
    assert.equal(result.markup, null, tex)
    assert.equal(typeof result.error, 'string', tex)
  }
  assert.equal(renderMath(String.raw`\frac{1}{2}`, false, katex).error, null, 'a bad formula must not poison the next one')
})

test('global definitions cannot leak into another formula', () => {
  assert.equal(renderMath(String.raw`\gdef\privateformula{x}\privateformula`, false, katex).error, null)
  assert.equal(renderMath(String.raw`\privateformula`, false, katex).markup, null)
})

test('untrusted commands cannot add links, images, styles or HTML nodes', () => {
  for (const tex of [
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\url{https://example.test/track}`,
    String.raw`\includegraphics{https://example.test/track.png}`,
    String.raw`\htmlStyle{background:url(https://example.test/track)}{x}`,
    String.raw`\htmlId{injected-id}{x}`,
    String.raw`\text{<img src=x onerror=alert(1)>}`,
  ]) {
    const result = renderMath(tex, false, katex)
    const markup = result.markup ?? ''
    assert.doesNotMatch(markup, /<(?:a|img|script|iframe|svg|style)\b/i, tex)
    assert.doesNotMatch(markup, /(?:href|src|id)="(?:javascript:|https:|injected-id)/i, tex)
    assert.doesNotMatch(markup, /style="[^"]*url\(/i, tex)
  }
})

test('user-specified rule dimensions are capped', () => {
  const result = renderMath(String.raw`\rule{999999em}{999999em}`, true, katex)
  assert.equal(result.error, null)
  // The annotation deliberately preserves the source for accessibility/copy;
  // only layout attributes must be capped.
  assert.doesNotMatch(result.markup, /(?:width|height|depth|voffset)="[^"]*999999/)
  assert.match(result.markup, /width="10em" height="10em"/)
})

test('oversized expansion and MathML trees never reach the page', () => {
  const amplified = String.raw`\def\a{` + 'x'.repeat(1500) + '}' + String.raw`\a`.repeat(200)
  assert.ok(amplified.length < MAX_MATH_LENGTH)
  assert.match(renderMath(amplified, false, katex).error, /too large/)
  const tooManyNodes = '<math>' + '<mi>x</mi>'.repeat(MAX_MATH_ELEMENTS) + '</math>'
  assert.match(renderMath('x', false, { renderToString: () => tooManyNodes }).error, /too many elements/)
})

test('uncapped offsets and negative spacing fail locally, not in layout', () => {
  const enormous = '9'.repeat(400)
  for (const tex of [
    String.raw`\raisebox{999999em}{x}`, String.raw`\raisebox{-999999em}{x}`, String.raw`\hspace{-999999em}x`,
    `\\raisebox{${enormous}em}{x}`,
    String.raw`\def\arraystretch{999999}\begin{array}{cc}a&b\\c&d\end{array}`,
    `\\def\\arraystretch{${enormous}}\\begin{array}{cc}a&b\\\\c&d\\end{array}`,
  ]) {
    const result = renderMath(tex, false, katex)
    assert.equal(result.markup, null, tex)
    assert.match(result.error, /size limit/, tex)
  }
  assert.equal(renderMath(String.raw`\raisebox{1em}{x}\hspace{-0.5em}y`, false, katex).error, null)
})

test('all TeX length units and cumulative relative font sizes are bounded', () => {
  for (const unit of ['em', 'ex', 'pt', 'px', 'bp', 'dd', 'cc', 'nd', 'nc', 'sp', 'mu', 'cm', 'mm', 'in', 'pc']) {
    const result = renderMath(`\\raisebox{999999999${unit}}{x}`, false, katex)
    assert.equal(result.markup, null, unit)
    assert.match(result.error, /size limit/, unit)
  }
  for (const count of [18, 100]) {
    const tex = '{\\Huge {\\tiny '.repeat(count) + 'x' + '}}'.repeat(count)
    assert.match(renderMath(tex, false, katex).error, /size limit/)
  }
  for (const tex of [
    String.raw`\llap{x}+\clap{y}`, String.raw`\raisebox{2dd}{x}`, String.raw`\hspace{-2pt}x`,
    String.raw`{\Huge x}+{\tiny y}`, String.raw`\pmb{x}`, String.raw`\fcolorbox{red}{blue}{x}`,
    String.raw`x=1\tag{1}`, String.raw`\begin{array}{cc}a&b\\c&d\end{array}`,
  ]) {
    assert.equal(renderMath(tex, true, katex).error, null, tex)
  }
})

function treeOf(dil) {
  const compiled = compileDil(dil)
  assert.deepEqual(compiled.diagnostics, [])
  const runtime = createDilRuntime()
  const batch = runtime.loadProgram({ code: compiled.code, constants: compiled.constants })
  assert.equal(batch.ok, true, batch.error?.message)
  const root = { id: ROOT_ID, childrenOrder: [], children: [] }
  const nodes = decodeTree(batch, { root })
  return { root, nodes }
}

test('quoted DIL and String.raw preserve LaTeX braces, slashes and matrix rows', () => {
  const tex = String.raw`\frac{\text{n}}{\theta}+\begin{pmatrix}a&b\\c&d\end{pmatrix}`
  const quoted = `<math tex=${JSON.stringify(tex)} display/>`
  const raw = '{@body const formula = String.raw`' + tex + '`}\n<math tex={formula} display/>'
  for (const dil of [quoted, raw]) {
    const { nodes } = treeOf(dil)
    const formula = [...nodes.values()].find((node) => node.type === 'math')
    assert.equal(formula.props.tex, tex)
    assert.equal(formula.props.display, true)
    assert.equal(renderMath(formula.props.tex, formula.props.display, katex).error, null)
  }
})

test('English and Chinese documentation examples preserve renderable LaTeX', async () => {
  const documents = [
    promptSectionText({ language: 'en' }),
    promptSectionText({ language: 'zh' }),
    await readFile(new URL('../README.md', import.meta.url), 'utf8'),
    await readFile(new URL('../README.en.md', import.meta.url), 'utf8'),
  ]
  for (const document of documents) {
    const examples = [...document.matchAll(/```dil\n([\s\S]*?)\n```/g)]
    assert.ok(examples.length > 0, 'missing executable formula example')
    for (const [, dil] of examples) {
      const { nodes } = treeOf(dil)
      const formulas = [...nodes.values()].filter((node) => node.type === 'math')
      assert.ok(formulas.length >= 2)
      for (const formula of formulas) {
        assert.doesNotMatch(formula.props.tex, /[\t\n\r]/, 'a LaTeX slash was consumed as a string escape')
        assert.equal(renderMath(formula.props.tex, formula.props.display, katex).error, null, formula.props.tex)
      }
      assert.equal(formulas[0].props.tex, String.raw`\frac{1}{2}`)
    }
  }
})

test('every streamed prefix of a formula remains compilable', () => {
  const dil = String.raw`<text>Before <math tex="\\frac{1}{2}"/> after.</text>`
  for (let length = 0; length <= dil.length; length += 1) {
    const compiled = compileDil(dil.slice(0, length))
    assert.doesNotThrow(() => new Function('__dil', 'DIL', 'GenUI', compiled.code), `prefix ${length}`)
  }
})

/** Inspect private functions only in the test's copy of the real page bundle.
 * The Worker adapter executes the actual offline source in a Node thread; the
 * React stub checks hook transitions, not browser DOM or visual layout.
 */
async function pageProbe(t) {
  let source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const anchor = 'exports.apply = __plugin.apply'
  assert.ok(source.includes(anchor))
  source = source.replace(anchor, `
    exports.mathProbe = { renderMathIsolated, createRenderers, workerSource: __IUI_MATH_WORKER_SOURCE, dispose: () => formulaService.dispose() }
    ${anchor}`)
  const urls = new Map()
  const threads = []
  class FormulaBlob {
    constructor(parts) { this.source = parts.join('') }
  }
  class FormulaURL extends URL {
    static createObjectURL(blob) { const url = 'test:formula-' + urls.size; urls.set(url, blob.source); return url }
    static revokeObjectURL(url) { urls.delete(url) }
  }
  class FormulaWorker {
    constructor(url) {
      assert.ok(urls.has(url))
      this.thread = new ThreadWorker(`
        const { parentPort } = require('node:worker_threads')
        const self = globalThis
        self.postMessage = (data) => parentPort.postMessage(data)
        ${urls.get(url)}
        parentPort.on('message', (data) => self.onmessage({ data }))
      `, { eval: true })
      threads.push(this.thread)
      this.thread.on('message', (data) => this.onmessage?.({ data }))
      this.thread.on('error', () => this.onerror?.({ preventDefault() {} }))
    }
    postMessage(data) { this.thread.postMessage(data) }
    terminate() { void this.thread.terminate() }
  }
  let registration
  const window = { __ModuleLoader__: { load: (value) => { registration = value } } }
  vm.runInNewContext(source, {
    window, URL: FormulaURL, Blob: FormulaBlob, Worker: FormulaWorker,
    AbortController, setTimeout, clearTimeout, console,
  }, { timeout: 1000 })
  let state = null
  let deps = null
  let unmount = null
  let onUpdate = () => {}
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('fragment'),
    useMemo: (compute) => compute(),
    useState: () => [state, (value) => { state = value; onUpdate() }],
    useEffect: (effect, next) => {
      if (deps !== null && deps.every((value, index) => Object.is(value, next[index]))) return
      unmount?.()
      deps = next
      unmount = effect()
    },
  }
  const exports = registration.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  const probe = exports.mathProbe
  t.after(async () => {
    unmount?.()
    probe.dispose()
    await Promise.all(threads.map((thread) => thread.terminate()))
    assert.equal(urls.size, 0, 'Blob URLs must be revoked')
  })
  const { renderNode } = probe.createRenderers(React)
  const draw = (props) => {
    const view = renderNode({ id: 'formula', type: 'math', props, children: [] })
    return view.type(view.props)
  }
  const render = async (props) => {
    const updated = new Promise((resolve) => { onUpdate = resolve })
    let node = draw(props)
    if (node.props.className === 'iui-math-pending') { await updated; node = draw(props) }
    return node
  }
  return { probe, threads, draw, render, runnerSource: exports.runnerSource }
}

test('the real page bundle starts math lazily in a separate offline Worker', async (t) => {
  const { probe, threads, runnerSource } = await pageProbe(t)
  assert.equal(threads.length, 0, 'loading the plugin must not start a formula Worker')
  assert.doesNotMatch(runnerSource, /__IUI_KATEX|__IUI_MATH_WORKER|renderToString|MathView/)
  assert.match(probe.workerSource, /__IUI_KATEX_LOAD/)
  assert.equal((await probe.renderMathIsolated('x^2')).error, null)
  assert.equal(threads.length, 1)
  assert.equal((await probe.renderMathIsolated('x^2')).error, null, 'an idle Worker may be restarted')
})

test('amplified input is rejected in the actual Worker and the next formula recovers', async (t) => {
  const { probe } = await pageProbe(t)
  const amplified = String.raw`\def\a{` + 'x'.repeat(1500) + '}' + String.raw`\a`.repeat(200)
  const bad = probe.renderMathIsolated(amplified)
  const good = probe.renderMathIsolated(String.raw`\frac{1}{2}`)
  const [failed, recovered] = await Promise.all([bad, good])
  assert.equal(failed.markup, null)
  assert.match(failed.error, /too large|timed out/)
  assert.equal(recovered.error, null)
  assert.match(recovered.markup, /<mfrac>/)
})

test('the bundled renderer draws inline/block formulas and recovers from bad input', async (t) => {
  const { render } = await pageProbe(t)
  const inline = await render({ tex: 'x^2' })
  assert.equal(inline.type, 'span')
  assert.equal(inline.props.style.color, 'inherit')
  assert.equal(inline.props.style.fontSize, 'inherit')
  assert.match(inline.props.dangerouslySetInnerHTML.__html, /<msup>/)
  const block = await render({ tex: String.raw`\frac{1}{2}`, display: true, size: 'lg', tone: 'brand' })
  assert.equal(block.type, 'div')
  assert.equal(block.props.style.overflowX, 'auto')
  assert.match(block.props.style.color, /var\(--dsw-/)
  assert.match(block.props.dangerouslySetInnerHTML.__html, /display="block"/)
  const bad = String.raw`\badCommand{<img src=x onerror=alert(1)>}`
  const failed = await render({ tex: bad })
  assert.equal(failed.props.className, 'iui-math-error')
  assert.equal(failed.props.dangerouslySetInnerHTML, undefined)
  assert.equal(failed.children[0], bad, 'the fallback must be escaped by React, not inserted as markup')
  const recovered = await render({ tex: 'y^3' })
  assert.equal(recovered.props.className, 'iui-math')
  assert.match(recovered.props.dangerouslySetInnerHTML.__html, /<msup>/)
  const huge = await render({ tex: 'x'.repeat(MAX_MATH_LENGTH + 10) })
  assert.equal(huge.children[0].length, MAX_MATH_LENGTH)
  assert.equal(huge.children[1], '…')
})

test('changing tex cancels obsolete work rather than painting a stale result', async (t) => {
  const { draw, render } = await pageProbe(t)
  const amplified = String.raw`\def\a{` + 'x'.repeat(1500) + '}' + String.raw`\a`.repeat(200)
  assert.equal(draw({ tex: amplified }).props.className, 'iui-math-pending')
  const updated = await render({ tex: 'z^2' })
  assert.equal(updated.props.className, 'iui-math')
  assert.match(updated.props.dangerouslySetInnerHTML.__html, /<mi>z<\/mi>/)
})

test('a timed-out Worker is terminated, the queue is bounded and later jobs recover', async (t) => {
  const workers = []
  let live = 0
  let peak = 0
  const service = createMathService({
    timeoutMs: 15, maxPending: 2,
    workerFactory: () => {
      const number = workers.length
      const worker = {
        stopped: false,
        postMessage(job) {
          if (number > 0) queueMicrotask(() => this.onmessage?.({ data: { id: job.id, result: { markup: '<math><mi>x</mi></math>', error: null } } }))
        },
        terminate() { this.stopped = true; live -= 1 },
      }
      workers.push(worker)
      live += 1
      peak = Math.max(peak, live)
      return worker
    },
  })
  t.after(() => service.dispose())
  const slow = service.render('slow')
  const next = service.render('x')
  assert.match((await service.render('overflow')).error, /Too many/)
  assert.match((await slow).error, /timed out/)
  assert.equal((await next).error, null)
  assert.equal(workers[0].stopped, true)
  assert.equal(peak, 1)
  assert.equal(live, 0, 'an idle Worker must not survive')
})

test('cancellation removes queued work and terminates active parsing', async (t) => {
  const workers = []
  const service = createMathService({ workerFactory: () => {
    const worker = {
      stopped: false,
      postMessage(job) {
        if (job.tex === 'x') queueMicrotask(() => this.onmessage?.({ data: { id: job.id, result: { markup: '<math/>', error: null } } }))
      },
      terminate() { this.stopped = true },
    }
    workers.push(worker)
    return worker
  } })
  t.after(() => service.dispose())
  const first = new AbortController()
  const queued = new AbortController()
  const active = service.render('slow', false, first.signal)
  const removed = service.render('queued', false, queued.signal)
  const good = service.render('x')
  queued.abort()
  first.abort()
  assert.match((await removed).error, /cancelled/)
  assert.match((await active).error, /cancelled/)
  assert.equal((await good).error, null)
  assert.equal(workers[0].stopped, true)
})

test('unavailable Workers and excessive responses fail locally without synchronous fallback', async () => {
  const unavailable = createMathService({ workerFactory: () => { throw new Error('blocked') } })
  assert.match((await unavailable.render('x')).error, /unavailable/)
  assert.equal((await unavailable.render('')).markup, '')
  unavailable.dispose()
  const oversized = createMathService({ workerFactory: () => ({
    postMessage(job) {
      queueMicrotask(() => this.onmessage?.({ data: { id: job.id, result: { markup: 'x'.repeat(MAX_MATH_MARKUP_LENGTH + 1), error: null } } }))
    },
    terminate() {},
  }) })
  assert.match((await oversized.render('x')).error, /too large/)
  oversized.dispose()
})

test('disposing resolves every active or queued job and releases the Worker', async () => {
  let stopped = false
  const service = createMathService({ workerFactory: () => ({ postMessage() {}, terminate() { stopped = true } }) })
  const active = service.render('x')
  const queued = service.render('y')
  service.dispose()
  assert.match((await active).error, /disposed/)
  assert.match((await queued).error, /disposed/)
  assert.match((await service.render('z')).error, /disposed/)
  assert.equal(stopped, true)
})
