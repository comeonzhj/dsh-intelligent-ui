# Vendored: Apache ECharts

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
