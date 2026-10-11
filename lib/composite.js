/**
 * Intelligent UI — composite components.
 *
 * A composite is written in DIL and shipped to the sandbox prebuilt: the model
 * uses it exactly like a native tag, and it lowers into native components
 * before the renderer ever sees it. ChatGPT draws the same line for its image
 * and product components.
 *
 * They are built **inside** the runner (`buildComposites` receives the
 * runner's own `__dil` and `DIL`), so their functions never have to cross the
 * worker boundary.
 *
 * Composites must be pure. A composite that calls `DIL.useState` shares one
 * slot across every instance, so state belongs in the card body instead.
 *
 * @module intelligent-ui/lib/composite
 */

import { componentPropNames } from './catalog.js'
import { compileComposite } from './compile.js'

/** Captured before lockdown removes `Function` from the runner global. */
const COMPILE = typeof Function === 'function' ? Function : null

/**
 * The DIL source of every composite, keyed by catalog name.
 *
 * `${ ... }` interpolations and `DIL.h(type, props, children)` are how a
 * composite builds dynamic children; `DIL.h` is the same factory the compiler
 * emits for static ones.
 */
export const COMPOSITE_SOURCES = Object.freeze({
  /** A responsive row of headline numbers. */
  statRow: `
<grid columns={columns} gap={3}>{(Array.isArray(items) ? items : []).map((item, index) => DIL.h("stat", {
  key: String(index),
  label: item.label,
  value: item.value,
  unit: item.unit,
  delta: item.delta,
  trend: item.trend,
  tone: item.tone,
  help: item.help
}))}</grid>`,

  /** One plan tile: name, headline price, feature list, call to action. */
  pricingCard: `
<box border radius="lg" padding={4} gap={3} background={featured ? "layer-3" : "layer-2"}>
  <row justify="between" align="center" gap={2}>
    <title size="md">{name}</title>
    {featured ? DIL.h("badge", { tone: "brand", variant: "soft" }, "Recommended") : null}
  </row>
  <row align="baseline" gap={1}>
    <title size="2xl">{price}</title>
    {period ? DIL.h("caption", { tone: "muted" }, String(period)) : null}
  </row>
  {Array.isArray(features) && features.length > 0
    ? DIL.h("list", null, features.map((feature, index) => DIL.h("item", { key: String(index) }, String(feature))))
    : null}
  {action === undefined || action === null
    ? null
    : DIL.h("button", {
        label: "Choose this plan",
        variant: featured ? "primary" : "outline",
        onClick: () => { if (onChange) onChange(action) }
      })}
  {DIL.h("field", { name: name || "plan", value: action })}
</box>`,

  /** Image, title, price, rating and a call to action. */
  productCard: `
<box border radius="lg" padding={3} gap={3}>
  {image ? DIL.h("image", { src: image, alt: title, ratio: "4:3", radius: "md" }) : null}
  <row justify="between" align="center" gap={2}>
    <title size="md">{title}</title>
    {badgeText ? DIL.h("badge", { tone: "warn", variant: "solid" }, String(badgeText)) : null}
  </row>
  <row align="baseline" gap={2}>
    <text weight="semibold" size="lg" tone="brand">{price}</text>
    {wasPrice ? DIL.h("caption", { tone: "muted" }, String(wasPrice)) : null}
  </row>
  {typeof rating === "number" && rating > 0
    ? DIL.h("row", { align: "center", gap: 2 },
        DIL.h("rating", { value: rating, max: 5 }),
        reviews ? DIL.h("caption", { tone: "muted" }, String(reviews) + " reviews") : null)
    : null}
  {action === undefined || action === null
    ? null
    : DIL.h("button", {
        label: "Choose",
        variant: "primary",
        onClick: () => { if (onChange) onChange(action) }
      })}
  {DIL.h("field", { name: name || "product", value: action })}
</box>`,

  /**
   * The recommended way to ask the human to choose: options become selectable
   * tiles, and the submit button sends the choice back to the model.
   */
  choiceCard: `
<box gap={3}>
  {prompt ? DIL.h("text", { weight: "semibold" }, String(prompt)) : null}
  <box gap={2}>{(Array.isArray(options) ? options : []).map((option, index) => DIL.h("option", {
    key: String(index),
    label: option.label === undefined ? String(option.value) : option.label,
    description: option.description,
    meta: option.meta,
    tone: option.tone,
    selected: value === option.value,
    onClick: () => { if (onChange) onChange(option.value) }
  }))}</box>
  {DIL.h("field", { name: name || "choice", value: value })}
</box>`,
})

/**
 * Compile every composite into a function bound to one runner's `__dil`/`DIL`.
 *
 * @param api - `{ __dil, DIL }` from the runtime instance.
 * @returns a `GenUI` catalog the runtime expands string tags against.
 */
export function buildComposites(api) {
  const catalog = {}
  if (COMPILE === null) return catalog
  for (const [name, source] of Object.entries(COMPOSITE_SOURCES)) {
    const { code } = compileComposite(source, componentPropNames(name))
    try {
      catalog[name] = COMPILE('__dil', 'DIL', `return (${code});`)(api.__dil, api.DIL)
    } catch {
      // A composite that fails to compile simply is not offered; the model's
      // tag then renders as an "unsupported" placeholder instead of breaking.
      catalog[name] = null
      delete catalog[name]
    }
  }
  return catalog
}
