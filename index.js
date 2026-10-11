/**
 * Intelligent UI — the Host half.
 *
 * This is the "server-side compilation" layer of the reference architecture,
 * mapped onto DSH's host plugin surface:
 *
 *   * the model calls one of **two** tools with a DIL document in its `dil`
 *     argument;
 *   * at call time the Host compiles that DIL into a JavaScript **program**
 *     plus a **constants** table, validates every property against the
 *     component catalog, and stores the result as the call's presentation
 *     metadata — the durable record the browser re-renders from;
 *   * a system-prompt section teaches the notation and carries the catalog.
 *
 * Two tools rather than one, because the two things a card can be are not the
 * same thing:
 *
 *   * `render_ui` **delivers** an answer. It is the card, and the model should
 *     then stop.
 *   * `ask_with_ui` **asks a question** mid-task, giving the answer controls a
 *     home. The conversation's own composer is the right place for feedback on
 *     a finished deliverable, so the delivery tool does not offer that contract
 *     at all — a rule enforced here rather than merely requested in the prompt.
 *
 * It imports nothing from `@deepseek-ai/*`, only its own relative modules, so
 * the package loads from any path — including a plain checkout and an ad-hoc
 * `--patch` overlay — without a node_modules tree.
 *
 * @module @comeonzhj/dsh-intelligent-ui
 */

import { compileDil } from './lib/compile.js'
import { componentNames } from './lib/catalog.js'
import {
  ASK_TOOL,
  DELIVER_TOOL,
  TOOL_NAMES,
  promptSectionText,
  receiptText,
  toolDescription,
} from './lib/prompt.js'

/** Prompt band: tool guidance, before subagent guidance. */
const PROMPT_ORDER = 2400

/**
 * The durable compilation record attached to every call.
 *
 * The reference implementation's `model_dil_v2` holds the raw text, the
 * compiled program and its data side by side; this is the same triple under
 * DSH's `presentationMeta`. The browser prefers it once the call has settled,
 * so a replayed transcript renders from the canonical compile rather than
 * re-deriving one.
 */
const META_VERSION = 3

const DEFAULT_SETTINGS = Object.freeze({
  detail: 'full',
  language: 'zh',
  prompt: true,
})

function readSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    detail: source.detail === 'compact' ? 'compact' : DEFAULT_SETTINGS.detail,
    language: source.language === 'en' ? 'en' : DEFAULT_SETTINGS.language,
    prompt: source.prompt === false ? false : DEFAULT_SETTINGS.prompt,
  }
}

/**
 * Parameters accepted by an answer contract.
 *
 * Only the clarification tool declares these, which is what keeps a feedback
 * form out of a finished deliverable.
 */
const ASK_PROPERTIES = {
  prompt: { type: 'string', description: 'The question, shown above the submit controls.' },
  submitLabel: { type: 'string', description: 'Submit button label, two to four words.' },
  notePlaceholder: { type: 'string', description: 'Placeholder for the optional free-text note box.' },
  allowNote: { type: 'boolean', description: 'Offer a free-text note box. Defaults to true.' },
}

const SHARED_PROPERTIES = {
  dil: {
    type: 'string',
    description: 'The interface in DIL: Markdown prose, JSX-like component tags, and `{@body ...}` JavaScript statement lines. See the Intelligent UI section of your instructions for the notation and the component catalog.',
  },
  title: {
    type: 'string',
    description: 'Short label shown above the card, e.g. "Team plan estimate".',
  },
  surface: {
    type: 'string',
    description: 'Stable kebab-case id of this card, e.g. "pricing". Reuse it when you revise the card.',
  },
}

/**
 * The two tools.
 *
 * `dil` is declared first on purpose: the arguments stream to the browser in
 * order, so the card starts growing from the first line the model writes.
 */
const TOOLS = [
  {
    name: DELIVER_TOOL,
    kind: 'deliver',
    parameters: {
      type: 'object',
      properties: SHARED_PROPERTIES,
      required: ['dil'],
      additionalProperties: false,
    },
  },
  {
    name: ASK_TOOL,
    kind: 'clarify',
    parameters: {
      type: 'object',
      properties: {
        ...SHARED_PROPERTIES,
        ask: {
          type: 'object',
          description: 'Required here: the question to put to the human, and how to present it.',
          properties: ASK_PROPERTIES,
          additionalProperties: false,
        },
      },
      required: ['dil', 'ask'],
      additionalProperties: false,
    },
  },
]

const OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    kind: { type: 'string', enum: ['deliver', 'clarify'] },
    title: { type: 'string' },
    nodes: { type: 'integer' },
    constants: { type: 'integer' },
    statements: { type: 'integer' },
    diagnostics: { type: 'array', items: { type: 'object', additionalProperties: true } },
    receipt: { type: 'string' },
  },
  required: ['ok', 'kind', 'title', 'nodes', 'constants', 'statements', 'diagnostics', 'receipt'],
  additionalProperties: false,
}

/** Normalize the model's arguments; `execute` receives them unvalidated. */
function readArguments(args, kind) {
  const source = args !== null && typeof args === 'object' ? args : {}
  const raw = source.ask !== null && typeof source.ask === 'object' ? source.ask : {}
  const diagnostics = []

  // `ask` on the delivery tool is not part of its schema, so a model that sends
  // one has ignored the contract. Drop it and say so, rather than quietly
  // rendering a feedback form on a finished deliverable.
  if (kind === 'deliver' && Object.keys(raw).length > 0) {
    diagnostics.push({ code: 'ask_not_allowed', tool: DELIVER_TOOL })
  }

  // Only defined keys are carried: this record is persisted and JSON-compared,
  // and an explicit `undefined` would survive neither.
  const answer = {}
  if (kind === 'clarify') {
    if (typeof raw.prompt === 'string') answer.prompt = raw.prompt
    if (typeof raw.submitLabel === 'string') answer.submitLabel = raw.submitLabel
    if (typeof raw.notePlaceholder === 'string') answer.notePlaceholder = raw.notePlaceholder
    answer.allowNote = raw.allowNote !== false
  }

  return {
    dil: typeof source.dil === 'string' ? source.dil : '',
    title: typeof source.title === 'string' && source.title.trim() !== '' ? source.title.trim() : '',
    surface: typeof source.surface === 'string' && source.surface.trim() !== '' ? source.surface.trim() : '',
    ask: answer,
    hasAsk: kind === 'clarify' && Object.keys(raw).length > 0,
    diagnostics,
  }
}

/** A short, stable label derived from the document when the model omits one. */
function deriveTitle(dil) {
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(String(dil))
  if (heading !== null) return heading[1].trim().slice(0, 80)
  const firstLine = String(dil).split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('{'))
  if (firstLine !== undefined) {
    const text = firstLine.replace(/<[^>]*>/g, '').replace(/[*`]/g, '').trim()
    if (text !== '') return text.slice(0, 80)
  }
  return 'Interactive card'
}

/**
 * Compile once per call and keep the artifact in the metadata.
 *
 * @param args - raw tool arguments.
 * @param settings - resolved plugin settings.
 * @param kind - `'deliver'` or `'clarify'`.
 * @returns `{ value, meta }` where `value` is the tool's declared output and
 *   `meta` is what the browser re-renders from.
 */
export function compileCall(args, settings, kind = 'deliver') {
  const normalized = readArguments(args, kind)
  const title = normalized.title !== '' ? normalized.title : deriveTitle(normalized.dil)
  const compiled = compileDil(normalized.dil)
  const diagnostics = [...normalized.diagnostics, ...compiled.diagnostics]

  // Every field must be lossless JSON: the record is persisted on the tool
  // result, and a value that does not survive the round trip fails the whole
  // call rather than just the card. Hence no `undefined`, not even as a key.
  const meta = {
    v: META_VERSION,
    kind,
    surface: normalized.surface,
    title,
    // The "raw text, compiled program and its data side by side" triple.
    dil: normalized.dil,
    code: compiled.code,
    constants: compiled.constants,
    diagnostics,
    fallbackMarkdown: compiled.fallbackMarkdown,
    stats: compiled.stats,
  }
  if (normalized.hasAsk) meta.ask = normalized.ask

  const value = {
    ok: true,
    kind,
    title,
    nodes: compiled.stats.nodes,
    constants: compiled.stats.constants,
    statements: compiled.stats.statements,
    diagnostics,
    receipt: '',
  }
  value.receipt = receiptText(value, settings.language)
  return { value, meta }
}

/**
 * The Cordis plugin.
 *
 * Services are injected by name only; nothing is imported from the harness, so
 * the registrations below are plain object literals.
 */
export const name = 'intelligent-ui'

export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  const settings = readSettings(config)

  ctx.effect(() => {
    const disposers = TOOLS.map((tool) => ctx.tools.register({
      name: tool.name,
      description: toolDescription(tool.kind, settings.language),
      parameters: tool.parameters,

      output: {
        schema: OUTPUT,
        // What the *model* reads: a short receipt, never the program.
        render: (_args, value) => [{ type: 'text', text: String(value.receipt ?? '') }],
        // What the *browser* re-renders from, persisted with the tool result.
        presentationMeta: (args) => compileCall(args, settings, tool.kind).meta,
      },

      async execute(args) {
        return compileCall(args, settings, tool.kind).value
      },
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'intelligent-ui: render_ui + ask_with_ui')

  if (settings.prompt) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'intelligent-ui',
      order: PROMPT_ORDER,
      text: () => promptSectionText({ detail: settings.detail, language: settings.language }),
    }), 'intelligent-ui: DIL protocol')
  }
}

/** Exposed for tests and for the client bundle's catalog checks. */
export { componentNames, TOOL_NAMES }
