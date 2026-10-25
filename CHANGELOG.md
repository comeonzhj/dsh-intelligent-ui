# Changelog

Notable changes, newest first. This project follows [Semantic
Versioning](https://semver.org/).

## Unreleased

- Add `<math tex="…" display size="lg" tone="brand"/>` for inline and display
  LaTeX formulas, using vendored KaTeX 0.19.1 to output native MathML offline.
  No runtime dependencies, external fonts, stylesheet or network requests.
- Run the lazy formula runtime in a separate, cancellable Worker, not on the page
  thread or in the DIL runner. Bound source, expansion, output size/elements,
  layout dimensions, queue length and render time; isolate macros per formula
  and fall back to local source text on errors or unavailable Workers.
- Document escaped LaTeX strings in the English and Chinese model prompts and
  READMEs; add real-vendor, generated-bundle and locked-runner formula tests.

## 0.1.1 — 2026-10-11

First release. `latest` points here.

> `0.1.0` carries identical content and landed moments earlier while the release
> was being verified, so both versions exist. `0.0.0-stage` is npm's
> staged-publish placeholder — not installable content.

**The pipeline**

- DIL: Markdown for prose, JSX-like tags for components, `{@body …}` lines for
  state and logic.
- Host-side compilation to a JavaScript program plus a constants table, with
  catalog validation and diagnostics, and partial-input tolerance so a response
  can be compiled while it is still streaming.
- A sandboxed runner (Blob Worker, and iframe / in-page fallbacks) whose global
  scope loses network, timers, messaging and dynamic evaluation before the first
  program runs.
- A keyed reconciler that emits integer-encoded operations against a per-batch
  string table; the page applies them to its own component tree.
- Two card seats: the tool row streams the interface while the arguments are
  still arriving, and the turn tail owns the settled card — the one transcript
  seat that is not folded behind a tool call.

**Tools**

- `render_ui` delivers a card. It has no answer contract, so a finished
  deliverable cannot grow a feedback entry point.
- `ask_with_ui` asks a question mid-task and carries the answer controls.
- Answers return as an ordinary user message, so they are durable in the session
  log and need no new RPC.

**Catalog**

- 49 components across layout, typography, controls and data display.
- 4 composite components written in DIL and compiled inside the runner:
  `statRow`, `pricingCard`, `productCard`, `choiceCard`.
- Five token scales; only `--dsw-*` tokens, so light and dark both resolve.

**Charts**

- `<chart>` is drawn with a vendored Apache ECharts 6.1.0 (the *common* build).
  `bar`, `line`, `area`, `pie`, `donut`, `scatter`, per-series type overrides for
  mixed charts, groups and stacks, legends, tooltips, value formatting, bounds,
  and automatic zoom for long category axes.
- `<sparkline>` stays a single inline SVG path — no chart instance for a 28px
  trend line.
- The chart runtime is loaded lazily, on the first card that draws one.

**Interaction**

- Drag, tick, toggle, type and select all happen locally, with no model call.
- `<textarea>` auto-grows and carries no resize handle.
- A card has exactly one way to be submitted.
