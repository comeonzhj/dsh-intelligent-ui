/**
 * Intelligent UI — model-facing text: the tool descriptions, the protocol
 * section that teaches DIL, and the receipt handed back after a call.
 *
 * Kept apart from `index.js` because this text *is* the interface between the
 * model and the catalog: it is the only place the accepted notation is stated,
 * and it is what a reviewer reads to understand what the model is allowed to
 * write.
 *
 * It is also where the rule about feedback lives. The delivery tool has no
 * answer contract at all — that is enforced in `index.js` — but a model that
 * has not been told *why* will keep reaching for one, so the protocol says so
 * in as many words.
 *
 * @module intelligent-ui/lib/prompt
 */

import { catalogText } from './catalog.js'

/** The delivery tool: the card is the answer. */
export const DELIVER_TOOL = 'render_ui'

/** The clarification tool: the card asks a question mid-task. */
export const ASK_TOOL = 'ask_with_ui'

/** Both wire names, in the order the prompt and the client mention them. */
export const TOOL_NAMES = Object.freeze([DELIVER_TOOL, ASK_TOOL])

const DESCRIPTIONS = {
  deliver: {
    zh: [
      '把一个结构化或可交互的回答渲染成对话里的「文字 + 富卡片」，而不是继续写散文。',
      '参数 `dil` 是 DIL：Markdown 写文字，JSX 风格标签写组件，`{@body ...}` 行写状态与计算。',
      '卡片就是你的回答本身。调用它，然后停下。',
      '不要在交付物里放反馈入口（「是否满意」「要不要调整」之类）：会话本身就有输入框，原生输入框更好用。',
    ].join(' '),
    en: [
      'Render a structured or interactive answer into the conversation as text plus a rich card, instead of writing more prose.',
      'The `dil` argument is DIL: Markdown for prose, JSX-like tags for components, and `{@body ...}` lines for state and logic.',
      'The card is the answer itself. Call it, then stop.',
      'Do not add a feedback entry point to a deliverable: the conversation already has an input box and the native one is better.',
    ].join(' '),
  },
  clarify: {
    zh: [
      '任务进行中向人提问，用一张卡片承载选项和控件。必须给出 `ask`（问题与提交按钮）。',
      '参数 `dil` 是 DIL。给控件写 `name`，提交时这些值会一起送回。',
      '调用后停下等人回答：答案会作为下一条用户消息到达。',
      '只在确实缺少继续所需的信息、必须让人做决定时使用；最终交付请用 `render_ui`。',
    ].join(' '),
    en: [
      'Ask the human a question mid-task, with the options and controls carried by a card. `ask` is required.',
      'The `dil` argument is DIL. Give the controls a `name`; the submit sends those values back.',
      'Stop after calling it: the answer arrives as the next user message.',
      'Use it only when you genuinely cannot continue without a decision. Deliverables use `render_ui`.',
    ].join(' '),
  },
}

/**
 * The DIL protocol, per language.
 *
 * Held as line arrays rather than template literals: the text is full of
 * backticks, fenced blocks and `${`-looking examples, and an escape-free source
 * is one a reviewer can diff against the rendered prompt.
 */
const PROTOCOL_HEAD = {
  zh: [
      "## Intelligent UI：文字 + 富卡片",
      "",
      "回答需要结构、选项、对比、数据或让人做决定时，用卡片代替散文。这里有两个工具：",
      "",
      "- `render_ui` —— **交付**一张卡片。卡片就是你的回答：调用它，然后停下。",
      "- `ask_with_ui` —— 任务进行中**向人提问**，把选项和控件放进卡片，并给出 `ask`。",
      "",
      "### 用哪个",
      "",
      "- 最终交付物用 `render_ui`。**不要在交付物里放反馈入口**（「是否满意」「要不要调整」之类）：",
      "  会话本身就有输入框，而且原生输入框更好用——它能带附件、斜杠指令和输入历史。",
      "  卡片末尾再挂一个反馈表单，只会让一个已经完成的回答显得没完成。",
      "- 只有当你确实缺少继续所需的信息、必须让人做个选择时，才用 `ask_with_ui`，并停在那里等人回答。",
      "",
      "### DIL 语法",
      "",
      "DIL 是 Markdown + JSX 风格标签 + JavaScript 三种记号的合体，一行一个构造：",
      "",
      "```",
      "## 标题（Markdown 标题 → title 组件）",
      "普通段落，可以用 **加粗**、*斜体*、`行内代码`、[链接](https://example.com)。",
      "",
      "- 列表项",
      "- 列表项",
      "",
      "{@body const [seats, setSeats] = DIL.useState(8)}",
      "{@body const price = seats * 29}",
      "<box border padding={3} gap={2}>",
      "  <slider min={1} max={50} value={seats} onChange={setSeats} label=\"席位数\" name=\"seats\"/>",
      "  <title size=\"xl\">${price} / mo</title>",
      "</box>",
      "```",
      "",
      "- **标签**：`<组件 属性=值>子节点</组件>`，或自闭合 `<组件/>`。无值属性表示 `true`（如 `border`）。",
      "- **属性值**：字符串用引号 `size=\"lg\"`，数字和表达式用花括号 `padding={3}`、`value={seats}`。",
      "- **插值**：文字里写 `{表达式}`，例如 `<title>{price} / mo</title>`。",
      "  写成 `${表达式}` 也可以，但 `$` 是普通文字 —— `${price}` 会渲染成 `$29`；想要货币符号就用这个写法。",
      "- **语句行**：`{@body ...}` 必须在自己的行上，可以出现在任意位置；它在渲染前执行。",
      "- **状态**：`DIL.useState(初始值)`、`DIL.useMemo(计算, [依赖])`、`DIL.useRef(初始值)`、`DIL.useCallback(函数, [依赖])`。",
      "  让 `value=` 绑定状态、`onChange=` 传更新函数，卡片就是活的。",
      "- **动态列表**：在 `{}` 里用 `DIL.h(组件名, 属性对象, 子节点)` 配合 `.map()`，例如",
      "  `{items.map((it) => DIL.h(\"stat\", { label: it.label, value: it.value }))}`。",
      "- **图表**：用 `<chart>`，数据写在 `series` 里，例如",
      "  `<chart type=\"bar\" categories={[\"Q1\",\"Q2\"]} series={[{name:\"营收\", data:[3,5]}]} legend={true}/>`。",
      "  可用的 `type`：bar / line / area / pie / donut / scatter；单条 series 也能用 `type` 覆盖，混排柱线。",
      "",
      "### 公式",
       "",
       "用 `<math tex=\"…\"/>` 放行内公式，`display` 放独立公式。LaTeX 必须放进 `tex`，不要写在标签正文或 `$…$` 里；引号字符串中的每个反斜杠写两次：",
       "```dil",
       String.raw`<text>分式 <math tex="\\frac{1}{2}"/> 与正文同行。</text>`,
       String.raw`<math tex="\\sum_{i=1}^n i = \\frac{n(n+1)}{2}" display size="lg"/>`,
       "```",
       "复杂或动态公式也可在 `{@body ...}` 中用 String.raw 模板字符串绑定，再传 `tex={formula}`。",
       "公式离线渲染为原生 MathML；默认继承周围字号和颜色，支持 `size`、`tone`。无效公式显示源文和错误提示，不影响其他组件。",
       "",
       "### 必须遵守",
      "",
      "1. 语句每行一条，写在 `{@body ...}` 里；不要写 `return`、`import`、`fetch`、`setTimeout` —— 沙箱里没有它们。",
      "2. 只使用下面目录里的组件和属性。写错会在编译期被丢弃并在卡片上标注。",
      "3. 间距、圆角、字号、颜色一律用 token（`padding={3}`、`size=\"lg\"`、`tone=\"success\"`），不要写像素值或十六进制颜色。",
      "4. 静态文字留在标签里；会变的数字用 `{表达式}`。",
      "5. 一次调用只渲染一张卡片。要修改，就再调用一次并复用同一个 `surface`。",
      "6. `render_ui` 之后不要再输出大段文字，也不要再调用其它工具。",
      "",
    ].join('\n'),
  en: [
      "## Intelligent UI: text plus a rich card",
      "",
      "When the answer has structure, options, a comparison, data, or a decision, use a card instead of prose. There are two tools:",
      "",
      "- `render_ui` -- **deliver** a card. The card IS the answer: call it, then stop.",
      "- `ask_with_ui` -- **ask the human** something mid-task, with the options and controls in the card and an `ask` contract.",
      "",
      "### Which one",
      "",
      "- Deliverables use `render_ui`. **Never put a feedback entry point in a deliverable** (\"was this helpful?\", \"anything to adjust?\"): the conversation already has an input box, and the native one is better -- it carries attachments, slash commands and prompt history. A feedback form bolted onto the end only makes a finished answer look unfinished.",
      "- Use `ask_with_ui` only when you genuinely cannot continue without a decision from the human, and stop there to wait for it.",
      "",
      "### DIL syntax",
      "",
      "DIL is Markdown, JSX-like tags and JavaScript in one notation, one construct per line:",
      "",
      "```",
      "## Heading (markdown heading -> title component)",
      "A paragraph, with **bold**, *italic*, `code` and [links](https://example.com).",
      "",
      "- a list item",
      "- another",
      "",
      "{@body const [seats, setSeats] = DIL.useState(8)}",
      "{@body const price = seats * 29}",
      "<box border padding={3} gap={2}>",
      "  <slider min={1} max={50} value={seats} onChange={setSeats} label=\"Seats\" name=\"seats\"/>",
      "  <title size=\"xl\">${price} / mo</title>",
      "</box>",
      "```",
      "",
      "- **Tags**: `<component prop=value>children</component>` or self-closing `<component/>`. A bare attribute means `true` (`border`).",
      "- **Prop values**: quotes for strings (`size=\"lg\"`), braces for numbers and expressions (`padding={3}`, `value={seats}`).",
      "- **Interpolation**: `{expression}` inside text, e.g. `<title>{price} / mo</title>`.",
      "  `${expression}` also works, but the `$` is ordinary text -- `${price}` renders as `$29`; use it when you want a currency sign.",
      "- **Statements**: `{@body ...}` on their own line, anywhere in the document; they run before the render.",
      "- **State**: `DIL.useState(initial)`, `DIL.useMemo(fn, [deps])`, `DIL.useRef(initial)`, `DIL.useCallback(fn, [deps])`.",
      "  Bind `value=` to state and pass an updater to `onChange=` to make the card live.",
      "- **Dynamic lists**: inside `{}`, `DIL.h(name, props, children)` with `.map()`, e.g.",
      "  `{items.map((it) => DIL.h(\"stat\", { label: it.label, value: it.value }))}`.",
      "- **Charts**: use `<chart>` and put the data in `series`, e.g.",
      "  `<chart type=\"bar\" categories={[\"Q1\",\"Q2\"]} series={[{name:\"Revenue\", data:[3,5]}]} legend={true}/>`.",
      "  Available `type`s: bar / line / area / pie / donut / scatter. A single series may override `type`, so bars and a line can share one chart.",
      "",
      "### Formulas",
       "",
       "Use `<math tex=\"…\"/>` inline, or `display` on its own line. Put LaTeX in `tex`, not children or `$…$` delimiters; double every backslash in quoted strings:",
       "```dil",
       String.raw`<text>A fraction <math tex="\\frac{1}{2}"/> within prose.</text>`,
       String.raw`<math tex="\\sum_{i=1}^n i = \\frac{n(n+1)}{2}" display size="lg"/>`,
       "```",
       "For complex or dynamic formulas, bind a String.raw template literal inside `{@body ...}`, then pass `tex={formula}`.",
       "Formulas render offline as native MathML, inherit surrounding type size and colour, and accept `size` and `tone`. Invalid formulas show their source with an error tooltip without breaking other components.",
       "",
       "### Rules",
      "",
      "1. One statement per line inside `{@body ...}`. No `return`, no `import`, no `fetch`, no `setTimeout` -- the sandbox has none of them.",
      "2. Use only the components and properties in the catalog below. Anything else is dropped at compile time and flagged on the card.",
      "3. Spacing, radius, type size and colour are tokens (`padding={3}`, `size=\"lg\"`, `tone=\"success\"`) -- never pixels or hex.",
      "4. Keep static text in the tags; make anything that changes a `{expression}`.",
      "5. One card per call. To revise, call again with the same `surface`.",
      "6. After `render_ui`, do not write more prose and do not call another tool.",
      "",
    ].join('\n'),
}

const ANSWER_HEAD = {
  zh: [
      "### 向人提问（只用 `ask_with_ui`）",
      "",
      "`ask` 里给出 `prompt`（问题）、`submitLabel`（提交按钮文字）、`allowNote`（是否给自由输入框）。",
      "给控件写 `name`：`<slider name=\"seats\" .../>`。提交时这些 `name` 的当前值会一起送回。",
      "`<choiceCard name=\"plan\" .../>` 这类复合组件的选择会自动进入答案。",
      "",
      "调用 `ask_with_ui` 后停下等人回答：答案会作为下一条用户消息到达。",
      "期间的交互（拖动、勾选、切换、输入）都在浏览器本地完成，不会调用你。",
      "提交按钮由 `ask.submitLabel` 决定：不要在卡片里自己写提交按钮（`<button submit/>`），卡片底部已经有一个；自己再写一个会出现两个提交入口。",
      "提交按钮由 `ask.submitLabel` 决定：不要在卡片里自己写提交按钮（`<button submit/>`），卡片底部已经有一个；再写一个就会出现两个提交入口。",
    ].join('\n'),
  en: [
      "### Asking the human (only with `ask_with_ui`)",
      "",
      "Pass `ask` with `prompt` (the question), `submitLabel`, and `allowNote`.",
      "Give the controls a `name`: `<slider name=\"seats\" .../>`. The submit sends every named value back.",
      "A composite such as `<choiceCard name=\"plan\" .../>` puts its selection into the answer automatically.",
      "",
      "Stop after `ask_with_ui` and wait: the answer arrives as the next user message.",
      "Everything done in the card meanwhile -- dragging, ticking, typing -- happens locally and does not call you.",
      "The submit button comes from `ask.submitLabel`: do not write your own (`<button submit/>`) — the card already has one at the bottom, and a second would give two ways to answer.",
      "The submit button comes from `ask.submitLabel`: do not write your own (`<button submit/>`) -- the card already has one at the bottom, and a second would give two ways to answer.",
    ].join('\n'),
}

/**
 * The system-prompt section that teaches DIL.
 *
 * @param options - `{ detail: 'full' | 'compact', language: 'zh' | 'en' }`.
 */
export function promptSectionText(options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const detail = options.detail === 'compact' ? 'compact' : 'full'
  return [PROTOCOL_HEAD[language], '', ANSWER_HEAD[language], '', '### Catalog', catalogText(detail)].join('\n')
}

/** One tool's description, shown wherever tools are listed. */
export function toolDescription(kind, language) {
  const table = kind === 'clarify' ? DESCRIPTIONS.clarify : DESCRIPTIONS.deliver
  return table[language === 'en' ? 'en' : 'zh']
}

/**
 * The one-line receipt the model reads after a call.
 *
 * It is the model's only feedback, so it says what was rendered, how large it
 * is, what the compiler had to adjust, and what happens next.
 */
export function receiptText(value, language) {
  const zh = language !== 'en'
  const clarify = value.kind === 'clarify'
  const parts = []
  parts.push(zh ? `已渲染卡片「${value.title}」。` : `Rendered the card "${value.title}".`)
  parts.push(zh
    ? `节点 ${value.nodes} 个，常量 ${value.constants} 个，语句 ${value.statements} 条。`
    : `${value.nodes} nodes, ${value.constants} constants, ${value.statements} statements.`)
  if (Array.isArray(value.diagnostics) && value.diagnostics.length > 0) {
    const described = value.diagnostics.slice(0, 6).map((d) => describeDiagnostic(d, language))
    parts.push(zh
      ? `编译期调整了 ${value.diagnostics.length} 处：${described.join('；')}。`
      : `The compiler adjusted ${value.diagnostics.length} thing(s): ${described.join('; ')}.`)
  }
  parts.push(clarify
    ? (zh
        ? '现在停下等人回答；答案会作为下一条用户消息到达。'
        : 'Stop here and wait; the answer arrives as the next user message.')
    : (zh
        ? '这是交付物，不要再追加反馈入口；人若要补充，会用会话输入框。'
        : 'This is the deliverable — do not append a feedback entry point; the human can reply in the composer.'))
  return parts.join(zh ? '' : ' ')
}

/** One diagnostic as short prose, in the language of the receipt. */
export function describeDiagnostic(diagnostic, language = 'zh') {
  const zh = language !== 'en'
  switch (diagnostic.code) {
    case 'unknown_prop':
      return zh ? `<${diagnostic.component}> 没有属性 ${diagnostic.prop}（已丢弃）` : `<${diagnostic.component}> has no property ${diagnostic.prop} (dropped)`
    case 'invalid_literal':
      return zh
        ? `<${diagnostic.component}> 的 ${diagnostic.prop} 取值不合法，应为 ${diagnostic.expected}（已丢弃）`
        : `<${diagnostic.component}>.${diagnostic.prop} expected ${diagnostic.expected} (dropped)`
    case 'unknown_component':
      return zh ? `目录里没有组件 <${diagnostic.component}>` : `no catalog component <${diagnostic.component}>`
    case 'unclosed_tag':
      return zh ? `<${diagnostic.tag}> 未闭合（已自动闭合）` : `<${diagnostic.tag}> was left open (auto-closed)`
    case 'stray_close_tag':
      return zh ? `多余的 </${diagnostic.tag}>` : `stray </${diagnostic.tag}>`
    case 'dropped_incomplete':
      return zh ? '丢弃了一段没写完的内容' : 'dropped an unfinished construct'
    case 'unsupported_scope':
      return zh ? `不支持的作用域 ${diagnostic.text}` : `unsupported scope ${diagnostic.text}`
    case 'statement_in_markup':
      return zh ? '标签内部不能写语句' : 'statements are not allowed inside markup'
    case 'dropped_return':
      return zh ? '不要写 return，卡片内容由标签决定' : 'do not write return; the tags decide the output'
    case 'ask_not_allowed':
      return zh
        ? '交付卡片不接受 ask 参数，反馈入口已移除（向人提问请用 ask_with_ui）'
        : 'the delivery tool takes no `ask`; the feedback entry point was dropped (use ask_with_ui to ask)'
    default:
      return diagnostic.code
  }
}
