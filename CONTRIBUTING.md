# Contributing

Thanks for looking. This is a small, dependency-free codebase; the goal is to
keep it that way.

## Getting set up

```sh
git clone https://github.com/comeonzhj/dsh-intelligent-ui
cd dsh-intelligent-ui
npm test          # builds client.js, then runs the suite
npm run dev       # boot an isolated profile and try it in the browser
```

There is nothing to install. There is no bundler, no test framework beyond
`node:test`, and no runtime dependency.

## The one rule that will bite you

**`client.js` is generated, and it is committed.**

```sh
npm run build
```

Run it after touching anything under `lib/`, `src/`, `scripts/`, or `vendor/`.
It is committed on purpose so that a `git` or GitHub install needs no build
step — a plugin that only works after `npm install && npm run build` is a plugin
most people will never get running. CI checks that the committed artifact is
current.

## Where things live

| Path | What belongs there |
|---|---|
| `index.js` | The host half: tool registration, host-side compilation, the prompt section. Must not import anything from `@deepseek-ai/*` — that is what lets the package load from any path without a `node_modules` tree. |
| `lib/catalog.js` | The contract between the model and the renderer: components, properties, tokens, validation, and the catalog text that ships in the prompt. |
| `lib/compile.js` | DIL → a JavaScript program plus a constants table plus diagnostics. |
| `lib/composite.js` | Composite components, written in DIL and compiled inside the runner. |
| `lib/prompt.js` | The words the model reads. Changes here change behaviour as much as code does. |
| `src/runtime/runtime.js` | The sandbox: hooks, reconciler, operation encoding, lockdown. |
| `src/client/chart.js` | Data → ECharts option. Pure, so it is testable without a DOM. |
| `src/client/components.js` | Catalog → harness design system. |
| `src/client/app.js` | The two card seats, streaming, interaction, the answer channel. |
| `test/` | One file per layer. |

## Adding a component

1. Add it to `COMPONENTS` in `lib/catalog.js`, with a `doc` line and a
   description on every property. The catalog text is generated from these, so
   what you write *is* the documentation the model reads.
2. Add a renderer in `src/client/components.js`. `test/catalog.test.mjs` fails
   if a catalog component has no renderer, or a renderer exists for something
   the model cannot write.
3. Use only `--dsw-*` tokens (with literal fallbacks) for colour, spacing and
   radius. Inline pixels are a bug: they break the dark theme.
4. Add it to the whole-catalog sample document in `test/catalog.test.mjs` so a
   typo in the schema is caught before a model ever writes one.

## Adding a chart type

`src/client/chart.js` and `test/chart.test.mjs` first, then widen
`CHART_TYPES` and the catalog's `type` enum together — they are asserted to be
equal. Check the vendored build can actually draw it (see `vendor/README.md`);
the catalog must not offer a type that silently renders as a bar.

## Tests

```sh
npm test                              # everything
node --test test/compile.test.mjs     # one file
node --test --test-name-pattern=chart # one name
```

Prefer a test that can fail. `test/bundle.test.mjs` is the model to copy when
the change touches the boundary between halves: it runs the real generated
`client.js` through a fake module loader, then the runner source in a fresh VM
realm, and decodes the operations the page would receive.

## Commits and pull requests

- One concern per commit; the message says *why*, not just what.
- `npm test` green, `client.js` rebuilt.
- If you change the model-facing protocol or catalog, say so in the PR
  description — those changes alter behaviour for every existing user prompt.

## Licence

Contributions are accepted under the MIT licence in `LICENSE`.
