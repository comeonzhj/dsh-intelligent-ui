# Intelligent UI

[![npm](https://img.shields.io/npm/v/@comeonzhj/dsh-intelligent-ui?label=npm)](https://www.npmjs.com/package/@comeonzhj/dsh-intelligent-ui)
[![CI](https://github.com/comeonzhj/dsh-intelligent-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/comeonzhj/dsh-intelligent-ui/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@comeonzhj/dsh-intelligent-ui)](LICENSE)
[![tests](https://img.shields.io/badge/tests-91-brightgreen)](test)

**Text + rich card answers for DeepSeek Harness.**

The model writes the interface in **DIL** — Markdown for prose, JSX-like tags for
components, JavaScript for state and logic. The host compiles that into a
JavaScript **program** plus a **constants** table. A sandboxed client runtime
executes the program and emits **operations**. The page applies those operations
to its own component tree, styled with the harness design system.

Moving a slider, ticking a switch or picking an option happens **locally in the
browser, with no model call**. Only an explicit submit sends the answer back, as
the user's next message.

This is a reverse-engineered implementation of ChatGPT's Intelligent UI.

![A delivered card](docs/card.png)

---

## Contents

- [What it is](#what-it-is)
- [Install](#install)
- [Two tools](#two-tools)
- [DIL in brief](#dil-in-brief)
- [Components and interactions](#components-and-interactions)
- [How an answer gets back](#how-an-answer-gets-back)
- [Where the card lives](#where-the-card-lives)
- [Settings](#settings)
- [Development and tests](#development-and-tests)
- [Layout](#layout)
- [Known limits](#known-limits)
- [Contributing](#contributing)
- [Licence](#licence)

---

## What it is

The reference implementation divides the work between the model, a backend
server, the client and a design system. Every one of those layers has a home on
DSH:

| Layer in ChatGPT's Intelligent UI | Here | Where |
|---|---|---|
| Inference format: Markdown + JSX-like tags + JS | DIL, in the `dil` argument of a tool | `lib/compile.js`, `index.js` |
| Server-side compilation to a JS program + JSON document | The host compiles at call time and persists the "raw text / program / constants" triple as the tool result's `presentationMeta` | `index.js` |
| Repair and validation against a catalog | Unknown properties and bad literals are dropped at compile time and recorded as diagnostics | `lib/compile.js`, `lib/catalog.js` |
| Partial-response compilation while streaming | Every partial argument prefix is recompiled; an unfinished statement is dropped and open elements are auto-closed | `lib/compile.js`, `src/client/app.js` |
| Sandboxed runtime (hidden iframe → Worker → lockdown) | A Blob Worker whose global scope loses network, timers, messaging and dynamic evaluation before the first program; plus iframe and in-page fallbacks | `src/runtime/runtime.js` |
| Reconciler producing UI operations | A small keyed reconciler: absolute-keyed hook slots, tree diff, integer-encoded operation stream with a string table | `src/runtime/runtime.js` |
| Rendering against native components | Drawn from the catalog, with every colour, gap and radius coming from `--dsw-*` tokens | `src/client/components.js` |
| Design system and catalog | 49 components, 4 composite components, 5 token scales | `lib/catalog.js` |
| Composite components written in DIL, shipped prebuilt | `statRow`, `pricingCard`, `productCard`, `choiceCard` | `lib/composite.js` |
| AppBlock escape hatch | **Not implemented.** On DSH its equivalent is a whole client plugin, not an inline block. | — |

Two deliberate decisions:

- **`{expr}` is the interpolation; a `$` before it is ordinary text**, so
  `${price}` renders as `$29`. This is not an accident of the parser: in the
  reverse-engineered constants table the source `${price}/mo` corresponds to
  `"4": "$"` and `"5": "/mo"`, which is only possible if `$` is literal. The
  prompt states the rule, so the model can use it deliberately for currency.
- **Property expressions are not wrapped individually.** An element whose
  properties are not all literals is wrapped once, so a property that throws
  removes that one element. The reference capture shows the same thing
  (`value: seats` bare, inside a wrapped `__dil.jsx` call).

---

## Install

This is a **bundle**: one npm package carrying both a host half (`index.js`) and a
browser half (`client.js`).

```sh
# from npm
dsh plugin --profile <your profile> add @comeonzhj/dsh-intelligent-ui

# from GitHub (pin a revision with #<sha>)
dsh plugin --profile <your profile> add github:comeonzhj/dsh-intelligent-ui
```

Then **restart that profile** — bundle membership is fixed at start. Afterwards
both tools are available to every agent in it.

> **Why the package is scoped**: `dsh-intelligent-ui` on npm is already a
> generative-UI plugin for DSH by another author. A name differing only by a
> suffix would be needlessly confusing, so this one is published under the
> author scope while keeping the concept's name.

### Just to try it, without installing anywhere

```sh
node scripts/dev-profile.mjs --boot
```

That writes a `--patch` overlay (mounting this checkout by absolute path),
creates a profile named `intelligent-ui-dev` if needed, boots it, and prints the
URL with its auth token. Your own profile is never touched.

> **If `dsh plugin add` hangs**, the `pnpm` on your `PATH` is the cause (some
> shims recurse through `pnpm dlx dlx dlx …`). Use the one the app ships:
> `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs`,
> wrapped on your `PATH`.

## Two tools

A card can be two very different things, so there are two tools rather than one
with a flag:

| Tool | Purpose | Feedback entry point |
|---|---|---|
| `render_ui` | **Deliver** a card. The card is the answer; stop after calling it. | **None** |
| `ask_with_ui` | **Ask the human** mid-task, with the options and controls in the card. `ask` is required. | Yes (submit button + optional note box) |

Why separate: **a finished deliverable should not carry a feedback entry point.**
The conversation already has an input box, and the native one is better — it
carries attachments, slash commands and prompt history. A "was this helpful?"
form bolted onto the end only makes a finished answer look unfinished.

This is not just prompt guidance: `render_ui` has no `ask` in its parameter
schema at all, and the host drops one if a model sends it anyway, recording an
`ask_not_allowed` diagnostic.

![A clarification card](docs/ask-card.png)

The answer footer appears only under `ask_with_ui`, and a card has **exactly one
way to be submitted** — either a `<button submit/>` the model wrote inside the
card, or the footer's own button, never both.

---

## DIL in brief

```
## Team plan estimate
Drag the slider to see the **monthly price** for your team.
{@body const [seats, setSeats] = DIL.useState(8)}
{@body const price = seats * 29}
<box border padding={3} gap={2}>
  <slider min={1} max={50} value={seats} onChange={setSeats} name="seats"/>
  <title size="xl">${price}/mo</title>
</box>
```

which compiles to

```js
function __dilSafe(evaluate, failureValue) { try { return evaluate(); } catch { return failureValue; } }

DIL.render(__dil.jsx(() => {
  const __dilConstants = DIL.useConstants();
  const [seats,setSeats] = DIL.useState(8, { key: "seats" });
  const price = __dilSafe(() => (seats * 29), undefined);
  return __dil.jsx(__dil.Fragment, null,
    __dil.jsx("title", { size: "lg" }, __dilConstants["0"]),
    __dil.jsx("text", null, __dilConstants["1"], __dil.jsx("bold", null, __dilConstants["2"]), __dilConstants["3"]),
    __dil.jsx("box", { border: true, padding: 3, gap: 2 },
      __dilSafe(() => __dil.jsx("slider", { min: 1, max: 50, value: (seats), onChange: (setSeats) }), null),
      __dil.jsx("title", { size: "xl" }, __dilConstants["4"], __dilSafe(() => (price), null), __dilConstants["5"])));
}, { key: "body:2" }));
```

with the constants `{"0":"Team plan estimate","1":"Drag the slider to see the ","2":"monthly price","3":" for your team.","4":"$","5":"/mo"}`.
Four mechanisms, each with a reason:

- **Plain function calls** — the runtime needs no parser for DIL.
- **Text in a separate table** — as a response streams, growing text changes the
  data, not the program.
- **Stable state keys** (`{ key: "seats" }`) — state survives every recompile.
- **Error isolation** — a throwing expression removes one element instead of
  aborting the render.

| Written | Meaning |
|---|---|
| `# …` `## …` | a `title`, sized by level |
| `**bold**` `*italic*` `` `code` `` `[t](u)` `> quote` `- item` ` ``` ` | the matching component |
| `<tag a="s" b={e} flag>children</tag>`, `<tag/>` | a catalog component |
| `{expression}` | an interpolated value |
| `{@body …}` on its own line | a statement in the render body, run before the render |
| `DIL.useState / useMemo / useRef / useCallback / useEffect` | hook state |
| `DIL.h(type, props, children)` inside `{}` | dynamic children, e.g. with `.map()` |

---

## Components and interactions

### Interactive

Every interaction happens locally in the browser and **never** calls the model. A
control with a `name` contributes its current value to the answer.

| Component | Interaction | Value in the answer |
|---|---|---|
| `<slider>` | drag | `value` (number) |
| `<stepper>` | step up/down | `value` (number) |
| `<rating>` | click a star | `value` (number) |
| `<switch>` | toggle | `checked` (boolean) |
| `<checkbox>` | tick | `checked` (boolean) |
| `<segmented>` | pick one | `value` |
| `<radio>` | pick one | `value` |
| `<select>` | choose from a list | `value` |
| `<input>` | type a line | `value` (text) |
| `<textarea>` | type several lines; **auto-grows, no resize handle** | `value` (text) |
| `<option>` | click to select (the tile `choiceCard` is built from) | via `onClick` + `<field>` |
| `<button>` | click; `submit={true}` submits the whole card | — |
| `<form>` | container; `submitLabel` generates a submit button | every named control inside |
| `<tabs>` / `<tab>` | switch panels locally | — |
| `<reveal>` | expand / collapse | — |
| `<link>` | open a URL | — |

### LaTeX formulas

`<math>` is a controlled DIL component, not an HTML escape hatch:

```dil
<text>A fraction <math tex="\\frac{1}{2}"/> within prose.</text>
<math tex="\\sum_{i=1}^n i = \\frac{n(n+1)}{2}" display size="lg" tone="brand"/>
{@body const matrix = String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`}
<math tex={matrix} display/>
```

- `tex` is the LaTeX string; `display` defaults to `false`. Display formulas scroll horizontally within their own container.
- Double backslashes in quoted strings, or bind a `String.raw` template literal as above. Do not put formulas in children; `$…$` and `$$…$$` are not automatically parsed.
- Size and colour inherit from surrounding text; `size` and `tone` accept the existing tokens. Changing `tex` through local state updates the formula without calling the model.
- KaTeX 0.19.1 is vendored offline and evaluated on demand only in a separate formula Worker. It outputs native MathML: no CDN, external fonts, KaTeX CSS, or dependency on shell styles. A MathML Core browser (such as current Chromium) is required.
- This supports KaTeX's LaTeX subset, not a full TeX engine. Invalid, unsupported or over-budget formulas fall back to source text with an error tooltip, without breaking other components. If Workers are unavailable, it takes that same fallback rather than parsing on the page thread.
- Input is limited to 8192 characters and macro expansion to 1000; generated numerical layout attributes are checked in addition to the engine's size limit. Each job has a 1-second deadline (including Worker startup), at most 32 jobs may be pending, and output is limited to 64 Ki characters and 2048 elements. Editing/unmounting cancels obsolete work; timeouts terminate the Worker and later jobs recover. Idle Workers are released.
- Trusted commands are disabled: no links, images or HTML attributes. Macro definitions are not shared across formulas. KaTeX runs neither on the page thread nor inside the DIL execution Worker.

### Charts

Drawn with Apache ECharts (the vendored *common* build, 698 KB, inlined into
`client.js`).

| `<chart type>` | Notes |
|---|---|
| `bar` | columns; `horizontal={true}` for bars; several series group, `stacked={true}` stacks |
| `line` | `smooth`, `area` fill, `dashed` |
| `area` | a line with fill |
| `pie` / `donut` | slices may each carry a `tone` |
| `scatter` | `symbolSize` sizes the points |

- A single series can **override** `type`, so bars and a line can share one chart.
- `categories` defaults to the first series' x values.
- `legend`, `valueFormat` (`number` / `currency` / `percent`), `min` / `max`,
  `height`, `labels` and `symbols` are all available.
- More than 24 categories earns a zoom strip.
- A theme flip re-colours open charts (tokens are read from `--dsw-*` as literals,
  because a canvas cannot resolve a CSS variable).

`<sparkline>` takes the other route: one inline SVG path, no chart instance.

### Composite components (written in DIL, shipped prebuilt)

| Component | Notes |
|---|---|
| `<statRow>` | a row of metric tiles (`items` + `columns`) |
| `<pricingCard>` | plan tile: name, price, feature list, call to action |
| `<productCard>` | image, title, price, rating, call to action |
| `<choiceCard>` | **the recommended way to ask**: options become selectable tiles |

### Static components

`box` `row` `grid` `card` `divider` `spacer` `scroll` `columns`
`title` `text` `bold` `italic` `code` `math` `caption` `label` `kbd` `quote` `callout` `list` `item`
`table` `kv` `stat` `progress` `badge` `pill` `avatar` `image` `gallery` `icon`
`sparkline` `timeline` `steps` `codeblock` `json`

`<field>` draws nothing: it declares one name/value pair so a composite can put
its own selection into the answer.

### Design tokens

| Scale | Values |
|---|---|
| `padding` / `gap` / `spacing` | `0`–`8` → 0/4/8/12/16/24/32/48/64 px |
| `radius` | `none` `sm` `md` `lg` `xl` `panel` `full` |
| `size` | `xs` `sm` `md` `lg` `xl` `2xl` `3xl` |
| `weight` | `regular` `medium` `semibold` `bold` |
| `tone` | `neutral` `muted` `brand` `success` `warn` `error` `info` |
| `background` | `none` `base` `layer-1` `layer-2` `layer-3` `overlay` |

`css` is the only escape hatch, and should stay one.

---

## How an answer gets back

No new RPC. On submit the client collects the card's **named values**, formats
them as an ordinary user message, and sends it with
`session.prompt(…, 'steer')`:

```
[Intelligent UI] 续费方案 — the user answered the card you rendered (call call-1).

- seats: 10
- plan: yearly
- note: 4 月开始，需要发票
```

So it is a durable session event and the model simply reads it on the next turn.
Collection rules:

1. A control with a `name` → `name: current value` (the component decides whether
   that is `value` or `checked`).
2. `<field name=… value=…>` → the pair as given.
3. A composite such as `choiceCard` hands its selection over through a `<field>`.

With no named values and no note, nothing is sent.

---

## Where the card lives

A card is contributed to two seats, and only one of them is ever the full card:

- **`tool.call.toolview`** (dispatched by `render_ui` / `ask_with_ui`) — while
  the model is still writing the arguments the turn is live and its tool row is
  on screen, so this is where the interface is watched growing. Once the call is
  dispatched the row collapses to a one-line receipt.
- **`conversation.chat.turnTail`** — the settled card. `turn-tail` is one of the
  few fold-independent node kinds in the transcript, so the card stays visible
  after the turn closes.

The split is not decoration. DSH's standard transcript view folds every tool call
behind the turn's completion disclosure — a reasonable default for a shell
command and a bad one for an answer that *is* an interface. The desktop app pins
that view; a web profile defaults to `detailed`, where tool calls render in
place. The turn tail sidesteps the question entirely.

---

## Settings

The row in `cordis.patch.yml` carries three settings:

| Setting | Default | Meaning |
|---|---|---|
| `prompt` | `true` | attach the DIL protocol and catalog to the system prompt |
| `detail` | `full` | `full` prints every property of every component; `compact` prints one line each |
| `language` | `zh` | language of the tool descriptions and the receipt |

---

## Development and tests

```sh
npm test     # builds client.js, then runs 91 tests
npm run build
npm run dev  # boot an isolated profile
```

```
compile.test.mjs   14  byte-for-byte against the reverse-engineered capture
runtime.test.mjs    9  the operation stream, local interaction, error isolation
chart.test.mjs     18  data → ECharts option
catalog.test.mjs    9  renderer coverage, composites, a whole-catalog document
client.test.mjs    15  partial-argument parsing, answer collection, message shape
host.test.mjs      15  tool schemas, the persisted record, the prompt section
bundle.test.mjs    12  client.js loads, the lockdown holds, a program runs in a sandbox
```

`bundle.test.mjs` is the valuable one: it executes the generated `client.js`
through a fake module loader, starts the shipped runner source in a fresh VM
realm, applies the lockdown, sends a compiled program, and decodes the resulting
operations with the page-side decoder. It is the only test that can catch a
bundle which fails to register, or a lockdown that removes the capability the
loader still needs.

**Run `npm run build` after changing anything.** `client.js` is a build artifact,
but it is committed on purpose, so a git install needs no build step.

---

## Layout

```
index.js                  Host half: the two tools, host-side compilation, the prompt section
client.js                 Browser half. GENERATED by scripts/build-client.mjs — do not edit
lib/catalog.js            Components, properties, tokens, validation, catalog text
lib/compile.js            DIL → program + constants + diagnostics; partial-input safe; no eval
lib/composite.js          Composite components, written in DIL, compiled inside the runner
lib/prompt.js             The DIL protocol, the tool descriptions, the receipt
src/runtime/runtime.js    Sandbox: hooks, reconciler, operation encoding, lockdown
src/client/chart.js       Data → ECharts option (pure, testable without a DOM)
src/client/components.js  Catalog → the harness design system
src/client/app.js         The two card seats, streaming, interaction, the answer channel
vendor/echarts.min.js     Apache ECharts (common build) + its licences
scripts/build-client.mjs  Flattens the modules into client.js and the runner blob
scripts/dev-profile.mjs   Writes a --patch overlay and boots an isolated profile
```

There is no bundler and no runtime dependency. The browser half of a DSH plugin
is a CommonJS closure registered with the page's module loader, and these modules
are plain ES modules whose only bundler-hostile lines are their `import`/`export`
statements — so the build is a few regular expressions, a collision check, and a
syntax check of the result before it reaches disk.

---

## Known limits

- **No AppBlock equivalent.** The model composes the catalog; it cannot ship an
  arbitrary web app. The reference implementation is equally restrictive about
  everything except its explicit escape hatch.
- **Composites are pure.** A composite calling `DIL.useState` shares one slot
  across every instance; state belongs in the card body.
- **Two sandboxes per card, over time.** The streaming card in the tool row and
  the settled card at the turn tail are separate runner instances. They are never
  both the full card, but an interaction made *while the arguments are still
  streaming* is not carried across.
- **`presentationMeta` must be lossless JSON.** A single `undefined` fails the
  whole tool call, not just the card, so the host omits absent fields rather than
  writing them as `undefined`.
- **Angle brackets in prose.** A `<` in body text starts a tag; write literals
  inside a component or avoid them.
- **Chart types are bounded by the vendored build**: radar, gauge, heatmap and
  funnel are not in the *common* build. Swap in the full `echarts.min.js`
  (1.12 MB) and widen the catalog's type list — see `vendor/README.md`.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

```sh
git clone https://github.com/comeonzhj/dsh-intelligent-ui
cd dsh-intelligent-ui
npm run build          # generate client.js (zero dependencies, plain node)
npm test               # 91 tests
npm run dev            # boot an isolated profile
```

**Run `npm run build` after changing anything under `lib/` or `src/`.**
`client.js` is a build artifact, but it is committed on purpose so that both git
and GitHub installs need no build step — and because there is no `prepare`
script, pnpm has nothing to block at install time.

### Publishing

```sh
npm login
npm publish            # `prepare` rebuilds client.js first
```

Bump with `npm version patch|minor|major` and update [CHANGELOG.md](CHANGELOG.md).

## Licence

MIT. Ships Apache ECharts (Apache-2.0) — see `vendor/ECHARTS-LICENSE.txt` and
`vendor/ECHARTS-NOTICE.txt`.

Charting by [Apache ECharts](https://echarts.apache.org). The sandbox and
rendering split follows the published analysis of OpenAI's ChatGPT Intelligent UI.

中文: [README.md](README.md)
