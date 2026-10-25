# Vendored browser runtimes

## Apache ECharts

`echarts.min.js` is the prebuilt **common** distribution of
[Apache ECharts](https://echarts.apache.org) 6.1.0.

Why it is vendored rather than depended on: the browser half of a DSH plugin
cannot `require()` anything outside the platform module table, so a chart library
can only reach the page by being inlined into `client.js` at build time. Shipping
the prebuilt file keeps the plugin's own build step dependency-free — there is no
bundler to install and nothing to compile, which is what makes `dsh plugin add`
work from a plain checkout.

## What the common build contains

Charts: `bar`, `line` (and `area` via `areaStyle`), `pie`, `donut` (via
`radius`), `scatter`.
Components: `aria`, `axis`, `axisPointer`, `dataZoom`, `dataset`, `graphic`,
`grid`, `legend`, `marker`, `title`, `toolbox`, `tooltip`.

It does **not** contain `radar`, `gauge`, `heatmap`, `funnel`, `treemap`,
`sankey`, `candlestick`, `boxplot`, `graph`, `lines` or `themeRiver`; those live
in the full `echarts.min.js` distribution (1.12 MB). The catalog only offers the
types this build can actually draw.

## Swapping in another build

Drop a different distribution over `echarts.min.js` and rebuild:

```sh
cp .../echarts/dist/echarts.min.js vendor/echarts.min.js   # full build, 1.12 MB
npm run build
```

The catalog's `chart.type` list is the only other place that needs to change.

## Licence

Apache License 2.0 — see `ECHARTS-LICENSE.txt` and `ECHARTS-NOTICE.txt`, both
reproduced verbatim from the distribution. ECharts is not modified here.

## KaTeX

`katex.min.js` is the unmodified UMD browser distribution of
[KaTeX](https://katex.org) **0.19.1** (MIT). `KATEX-LICENSE.txt` is its license,
reproduced verbatim from the npm archive:

- Source: <https://registry.npmjs.org/katex/-/katex-0.19.1.tgz>
- Archive integrity (SHA-512/base64):
  `jG8uKntjSEcm2EpQOh0XturpPuuC9r3Sq5HLHdsFdWZT27E672SF19QEi+of0/YeOy15lDgRhKvr5614uRrEfA==`
- Files: `package/dist/katex.min.js` → `katex.min.js`,
  `package/LICENSE` → `KATEX-LICENSE.txt`.

The same dependency-free build wraps it in a private CommonJS scope and serializes
it into an offline formula Worker source. Only a nonempty `<math>` starts that
Worker; KaTeX is evaluated neither on the page thread nor in the DIL sandboxed
runner. Rendering uses `output: 'mathml'`: the browser lays out native MathML, so
no KaTeX CSS, webfonts, CDN, shell-global library or auto-render extension is
needed. This targets the modern Chromium/Electron browser used by DSH; it is not
a promise of identical layout in older browsers without MathML support.

Input is untrusted: `trust: false`, a fresh macros object per formula, 1000 macro
expansions, `maxSize: 10` and an 8192-character source limit. Because expansion
count does not bound expansion volume, parsing runs in one terminable Worker,
with a 1000 ms deadline including startup and at most 32 pending jobs. Output is
checked using complete length values (including legacy TeX units), cumulative
relative font sizes and finite-value checks, and limited to 65536 characters /
2048 elements before posting to the page, then checked again at the
page boundary. Cancellation/timeouts terminate active parsing; queued jobs can
recover, and the Worker is released when idle. There is no synchronous fallback
if Workers are blocked. Model-written markup is never inserted; only the pinned
library's bounded output is. All failures fall back to React text, not `innerHTML`.

To update, verify the new archive's integrity, replace those two files, update
the version/integrity here and in the tests, then rebuild and test the bundle.
