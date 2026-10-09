import type { AgentPermissionRequest, AgentPermissionResponse, ToolCallDetail } from "@getpaseo/protocol/agent-types"
import { RGBA, SyntaxStyle, TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { dialog, truncate } from "./dialog"
import type { Mark } from "./paseo"
import { truncateFilePath } from "./render/file-path"
import { activitySummary, explorationSummary, groupTranscript, reasoningContent, reasoningTitle, type Grouping, type TranscriptNode, type Verbosity } from "./render/grouping"
import { collapseToolOutput, editDiff, filetype, reasoningSummary, timestampLabel } from "./render/helpers"
import { collapseShellOutput } from "./render/shell-output"
import { durationLabel, turnFooters, type TurnFooter } from "./render/turns"
import { collapseForkContext, errorText, imageFile, toolSummary, type AgentTimelineItem, type ToolCallTimelineItem } from "./timeline"
import { syntax, theme } from "./theme"

// Rendering adapted from OpenCode (MIT); see render/OPENCODE-LICENSE.
export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}
export const SplitBorder = { ...EmptyBorder, vertical: "┃" }

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export function Spinner(props: { color?: typeof theme.text; children?: string }) {
  const [frame, setFrame] = createSignal(0)
  const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 80)
  onCleanup(() => clearInterval(timer))
  return (
    <text fg={props.color ?? theme.textMuted}>
      {frames[frame()]}
      {props.children ? ` ${props.children}` : ""}
    </text>
  )
}

export type TranscriptProps = {
  rows: AgentTimelineItem[]
  times: number[]
  marks: Mark[]
  running: boolean
  agent: { label: string; color: RGBA }
  model: string
  verbosity: Verbosity
  thinking: "show" | "hide"
  grouping: Grouping
  details: boolean
  timestamps: boolean
  diffStyle: "auto" | "unified" | "split"
  tps: boolean
  attachments?: (row: Extract<AgentTimelineItem, { type: "user_message" }>, index: number) => { mimeType: string; data?: string; name?: string }[]
}

// Ported from OpenCode 2.0.26 routes/session/index.tsx row dispatch (MIT); see render/OPENCODE-LICENSE.
export function Transcript(props: TranscriptProps): JSX.Element {
  const nodes = createMemo(() => groupTranscript(props.rows, props.verbosity))
  const footers = createMemo(() => turnFooters(props.rows, props.times, props.marks, props.running))
  return <TranscriptNodes nodes={nodes()} transcript={props} footers={footers()} />
}

// Ported from OpenCode 2.0.26 SessionRowView (MIT); see render/OPENCODE-LICENSE.
function TranscriptNodes(props: { nodes: TranscriptNode[]; transcript: TranscriptProps; footers?: Map<number, TurnFooter>; thought?: boolean; spacing?: boolean }) {
  const nodes = createMemo(() => new Map(props.nodes.map((node) => [node.index, node])))
  // Index keys preserve markdown renderables and disclosures across streamed deltas.
  return <For each={[...nodes().keys()]}>{(index) => {
    const node = () => nodes().get(index)!
    const end = () => { const value = node(); return value.type === "group" ? value.indices.at(-1)! : value.index }
    return <box id={props.footers ? `row-${index}` : undefined} marginTop={props.footers || props.spacing ? 1 : 0} flexShrink={0}>
      <Show when={node().type === "group" && (node() as Extract<TranscriptNode, { type: "group" }>).kind} keyed fallback={<TranscriptEntry index={index} transcript={props.transcript} thought={props.thought} />}>
        <TranscriptGroup node={node() as Extract<TranscriptNode, { type: "group" }>} transcript={props.transcript} />
      </Show>
      <Show when={props.footers?.get(end())}>{(footer) => <AssistantFooter footer={footer()} transcript={props.transcript} />}</Show>
    </box>
  }}</For>
}

// Ported from OpenCode 2.0.26 group-view.tsx (MIT); see render/OPENCODE-LICENSE.
function TranscriptGroup(props: { node: Extract<TranscriptNode, { type: "group" }>; transcript: TranscriptProps }) {
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal<boolean>()
  const [hover, setHover] = createSignal(false)
  const open = () => expanded() ?? (props.transcript.verbosity === "high" && props.node.kind === "exploration")
  const grouped = () => props.node.kind === "activity" || (props.node.kind === "reasoning" ? props.transcript.thinking === "hide" : props.transcript.grouping !== "none")
  const summary = createMemo(() => activitySummary(props.transcript.rows, props.node.indices, props.transcript.running))
  const exploration = createMemo(() => explorationSummary(props.transcript.rows, props.node.indices, props.transcript.running))
  const done = () => props.node.kind === "exploration" ? exploration().completed : !summary().active
  const thoughtTitle = createMemo((previous: string | null) => {
    const index = props.node.indices.at(-1)!
    const item = props.transcript.rows[index]
    if (item?.type !== "reasoning") return previous
    const title = reasoningTitle(item.text)
    if (title) return title
    return !props.transcript.running || index < props.transcript.rows.length - 1 ? null : previous
  }, null)
  const label = () => {
    if (props.node.kind === "activity") return summary().label
    if (props.node.kind === "exploration") return exploration().label
    if (!done()) return thoughtTitle() ? `Thinking: ${thoughtTitle()}` : "Thinking"
    const count = props.node.indices.filter((i) => { const item = props.transcript.rows[i]; return item?.type === "reasoning" && reasoningContent(item.text) }).length
    return `Thought${!open() && thoughtTitle() ? `: ${thoughtTitle()}` : ""}${count > 1 ? ` · ${count} steps` : ""}`
  }
  const color = () => props.node.kind === "reasoning" ? !done() ? theme.text : hover() || open() ? theme.warning : RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, 0.6) : hover() ? theme.text : theme.textMuted
  const icon = () => props.node.kind === "exploration" ? "→" : open() ? props.node.kind === "activity" ? "−" : "-" : "+"
  const visible = () => props.node.kind !== "reasoning" || props.node.indices.some((i) => { const item = props.transcript.rows[i]; return item?.type === "reasoning" && reasoningContent(item.text) })
  return <Show when={visible()}>
    <Show when={grouped()} fallback={<TranscriptNodes nodes={props.node.children} transcript={props.transcript} />}>
      <box paddingLeft={3}
        onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}
        onMouseUp={() => !renderer.getSelection()?.getSelectedText() && setExpanded(!open())}>
        <Show when={(props.node.kind === "activity" ? summary().active && !open() : !done())} fallback={
          <box flexDirection="row"><text width={2} fg={color()}>{icon()}</text><text flexGrow={1} fg={color()}>{label()}</text></box>
        }><Spinner color={color()}>{label()}</Spinner></Show>
      </box>
      <Show when={open()}>
        <box paddingLeft={props.node.kind === "reasoning" ? 3 : 0}>
          <TranscriptNodes nodes={props.node.children} transcript={props.transcript} thought={props.node.kind === "reasoning"} spacing={props.node.kind !== "exploration"} />
        </box>
      </Show>
    </Show>
  </Show>
}

// Ported from OpenCode 2.0.26 UserMessage/TextPart (MIT); see render/OPENCODE-LICENSE.
function TranscriptEntry(props: { index: number; transcript: TranscriptProps; thought?: boolean }) {
  const [hover, setHover] = createSignal(false)
  const item = () => props.transcript.rows[props.index]!
  const attachments = createMemo(() => {
    const row = item()
    return row.type === "user_message" ? props.transcript.attachments?.(row, props.index) ?? [] : []
  })
  const streaming = () => props.transcript.running && props.index === props.transcript.rows.length - 1
  return <Switch>
    <Match when={item().type === "user_message" && item() as Extract<AgentTimelineItem, { type: "user_message" }>}>{(message) =>
      <box border={["left"]} borderColor={props.transcript.agent.color} customBorderChars={SplitBorder} backgroundColor={theme.backgroundPanel}>
        <SessionImages attachments={attachments()} />
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} flexShrink={0} backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}>
          <text fg={theme.text}>{collapseForkContext(message().text)}</text>
          <Show when={attachments().length}>
            <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
              <For each={attachments()}>{(attachment) => <text>
                <span style={{ bg: theme.accent, fg: theme.backgroundPanel, bold: true }}> file </span>
                <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>{` ${attachment.name ?? "clipboard"} `}</span>
              </text>}</For>
            </box>
          </Show>
          <Show when={props.transcript.timestamps}><text marginTop={1} fg={theme.textMuted}>{timestampLabel(props.transcript.times[props.index]!)}</text></Show>
        </box>
      </box>
    }</Match>
    <Match when={item().type === "assistant_message" && imageFile((item() as Extract<AgentTimelineItem, { type: "assistant_message" }>).text)}>{(file) =>
      <box paddingLeft={1} flexShrink={0}><SessionImages attachments={[{ mimeType: "image", path: file() }]} /></box>
    }</Match>
    <Match when={item().type === "assistant_message" && item() as Extract<AgentTimelineItem, { type: "assistant_message" }>}>{(message) =>
      <Show when={message().text.trim()}><box paddingLeft={3} flexShrink={0}>
        <markdown syntaxStyle={syntax()} content={message().text.trim()} streaming={streaming()} internalBlockMode="top-level" tableOptions={{ style: "grid", cellPaddingX: 1 }} conceal fg={theme.markdownText} bg={theme.background} />
      </box></Show>
    }</Match>
    <Match when={item().type === "reasoning" && item() as Extract<AgentTimelineItem, { type: "reasoning" }>}>{(thought) =>
      <Show when={reasoningContent(thought().text)}>
        <Show when={props.thought} fallback={<TranscriptReasoning text={thought().text} streaming={streaming()} />}>
          <box border={["left"]} customBorderChars={SplitBorder} borderColor={theme.backgroundElement} paddingLeft={1}>
            <ReasoningCode text={thought().text} streaming={streaming()} />
          </box>
        </Show>
      </Show>
    }</Match>
    <Match when={item().type === "tool_call" && item() as ToolCallTimelineItem}>{(tool) =>
      <ToolRow tool={tool()} separate={false} showDetails={props.transcript.details} diffStyle={props.transcript.diffStyle} transcript />
    }</Match>
    <Match when={item().type === "error" && item() as Extract<AgentTimelineItem, { type: "error" }>}>{(error) =>
      <Show when={!/^(Step interrupted|Turn interrupted|Interrupted|Canceled|Cancelled)$/i.test(error().message)}><box paddingLeft={3}><text fg={theme.error}>Error: {error().message}</text></box></Show>
    }</Match>
    <Match when={true}><TimelineRow item={item()} streaming={streaming()} showDetails={props.transcript.details} compact /></Match>
  </Switch>
}

// Ported from OpenCode 2.0.26 routes/session/index.tsx SessionImages (MIT); see render/OPENCODE-LICENSE.
function SessionImages(props: { attachments: { mimeType: string; data?: string; name?: string; path?: string }[] }) {
  const dimensions = useTerminalDimensions()
  const images = createMemo(() => props.attachments.filter((attachment) => attachment.path || (attachment.data !== undefined && attachment.mimeType.startsWith("image/"))))
  const height = () => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4)))
  const visible = createMemo(() => images().slice(0, 3))
  return <Show when={visible().length}>
    <box flexDirection="row" flexShrink={0} paddingTop={1} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <For each={visible()}>{(attachment) => {
        const [failed, setFailed] = createSignal(false)
        const source = attachment.path ?? Uint8Array.from(Buffer.from(attachment.data!, "base64"))
        return <box width={height() * 2} height={height()} flexBasis={height() * 2} flexShrink={1} alignItems="center" justifyContent="center">
          <Show when={!failed()} fallback={<text>No preview</text>}>
            <image source={source} fit="cover" protocol="auto" width="100%" height="100%" onError={() => setFailed(true)} />
          </Show>
        </box>
      }}</For>
      <Show when={images().length > visible().length}>
        <box width={8} height={height()} flexShrink={1} alignItems="center" justifyContent="center">
          <text wrapMode="none" truncate>+{images().length - visible().length} more</text>
        </box>
      </Show>
    </box>
  </Show>
}

// Ported from OpenCode 2.0.26 message-parts.tsx ReasoningPart (MIT); see render/OPENCODE-LICENSE.
function TranscriptReasoning(props: { text: string; streaming: boolean }) {
  const color = () => RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, 0.6)
  return <box paddingLeft={3} flexShrink={0}>
    <box border={["left"]} customBorderChars={SplitBorder} borderColor={theme.backgroundElement} paddingLeft={1}>
      <Show when={props.streaming} fallback={<text fg={color()}>Thought</text>}><Spinner color={color()}>Thinking</Spinner></Show>
    </box>
    <box marginTop={1} border={["left"]} customBorderChars={SplitBorder} borderColor={theme.backgroundElement} paddingLeft={1}>
      <ReasoningCode text={props.text} streaming={props.streaming} />
    </box>
  </box>
}

// Ported from OpenCode 2.0.26 thinking-syntax.ts (MIT); see render/OPENCODE-LICENSE.
function ReasoningCode(props: { text: string; streaming: boolean }) {
  const thinkingSyntax = createMemo(() => {
    const style = SyntaxStyle.fromStyles(Object.fromEntries(syntax().getRegisteredNames().map((name) => [name, { ...syntax().getStyle(name), fg: theme.textMuted }])))
    onCleanup(() => style.destroy())
    return style
  })
  return <code filetype="markdown" drawUnstyledText={false} streaming={props.streaming} syntaxStyle={thinkingSyntax()} content={reasoningContent(props.text)} conceal fg={theme.textMuted} />
}

// Ported from OpenCode 2.0.26 AssistantFooter (MIT); see render/OPENCODE-LICENSE.
function AssistantFooter(props: { footer: TurnFooter; transcript: TranscriptProps }) {
  const dimensions = useTerminalDimensions()
  return <box paddingLeft={3} marginTop={1}><text>
    <span style={{ fg: props.footer.error || props.footer.interrupted ? theme.textMuted : props.transcript.agent.color }}>{props.transcript.agent.label}</span>
    <Show when={dimensions().width >= 28}><span style={{ fg: theme.textMuted }}> · {props.transcript.model}</span></Show>
    <Show when={props.footer.duration && (dimensions().width < 28 || dimensions().width >= 36)}><span style={{ fg: theme.textMuted }}> · {durationLabel(props.footer.duration)}</span></Show>
    <Show when={props.transcript.tps && props.footer.tps}><span style={{ fg: theme.textMuted }}> · {props.footer.tps!.toFixed(1)} tok/s</span></Show>
    <Show when={props.footer.interrupted}><span style={{ fg: theme.textMuted }}> · interrupted</span></Show>
  </text></box>
}

export function TimelineRow(props: {
  item: AgentTimelineItem
  previous?: AgentTimelineItem
  streaming: boolean
  showThinking?: boolean
  showDetails: boolean
  thinking?: "show" | "hide" | "collapsed"
  thinkingDurationMs?: number
  timestamp?: number
  showTimestamps?: boolean
  diffStyle?: "unified" | "split" | "auto"
  compact?: boolean
}) {
  const item = () => props.item
  return (
    <Switch>
      <Match when={item().type === "user_message" && (item() as Extract<AgentTimelineItem, { type: "user_message" }>)}>
        {(message) => (
          <box border={["left"]} borderColor={theme.agent} customBorderChars={SplitBorder} marginTop={props.compact ? 0 : 1} flexShrink={0}>
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
              <text fg={theme.text}>{collapseForkContext(message().text)}</text>
              <Show when={props.showTimestamps && props.timestamp !== undefined}>
                <text marginTop={1} fg={theme.textMuted}>{timestampLabel(props.timestamp!)}</text>
              </Show>
            </box>
          </box>
        )}
      </Match>
      <Match when={item().type === "assistant_message" && (item() as Extract<AgentTimelineItem, { type: "assistant_message" }>)}>
        {(message) => (
          <Show when={message().text.trim()}>
            <box paddingLeft={3} marginTop={props.compact ? 0 : 1} flexShrink={0}>
              <markdown
                syntaxStyle={syntax()}
                streaming={props.streaming}
                internalBlockMode="top-level"
                content={message().text.trim()}
                conceal
                fg={theme.markdownText}
                bg={theme.background}
                tableOptions={{ style: "grid" }}
              />
            </box>
          </Show>
        )}
      </Match>
      <Match when={item().type === "reasoning" && (item() as Extract<AgentTimelineItem, { type: "reasoning" }>)}>
        {(reasoning) => <ReasoningRow text={reasoning().text} mode={props.showThinking === false ? "hide" : props.thinking ?? "show"} streaming={props.streaming} durationMs={props.thinkingDurationMs} />}
      </Match>
      <Match when={item().type === "tool_call" && (item() as ToolCallTimelineItem)}>
        {(tool) => <ToolRow tool={tool()} separate={props.previous?.type !== "tool_call"} showDetails={props.showDetails} diffStyle={props.diffStyle} />}
      </Match>
      <Match when={item().type === "todo" && (item() as Extract<AgentTimelineItem, { type: "todo" }>)}>
        {(todo) => (
            <box paddingLeft={3} marginTop={props.compact ? 0 : 1} flexShrink={0}>
            <For each={todo().items}>
              {(task) => {
                const active = task.status === "in_progress"
                return (
                  <text fg={task.completed ? theme.textMuted : active ? theme.warning : theme.text}>
                    {task.completed ? "[✓]" : active ? "[•]" : "[ ]"} {task.text}
                  </text>
                )
              }}
            </For>
          </box>
        )}
      </Match>
      <Match when={item().type === "error" && (item() as Extract<AgentTimelineItem, { type: "error" }>)}>
        {(error) => (
          <box border={["left"]} borderColor={theme.error} customBorderChars={SplitBorder} marginTop={props.compact ? 0 : 1} flexShrink={0}>
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
              <text fg={theme.textMuted}>{error().message}</text>
            </box>
          </box>
        )}
      </Match>
      <Match when={item().type === "notification" && (item() as Extract<AgentTimelineItem, { type: "notification" }>)}>
        {(note) => (
            <box paddingLeft={3} marginTop={props.compact ? 0 : 1} flexShrink={0}>
            <text fg={note().level === "error" ? theme.error : note().level === "warning" ? theme.warning : theme.textMuted}>{note().message}</text>
          </box>
        )}
      </Match>
      <Match when={item().type === "compaction" && (item() as Extract<AgentTimelineItem, { type: "compaction" }>)}>
        {(compaction) => (
          <box marginTop={props.compact ? 0 : 1} border={["top"]} title={compaction().status === "loading" ? " Compacting… " : " Compaction "} titleAlignment="center" borderColor={theme.textMuted} flexShrink={0} />
        )}
      </Match>
    </Switch>
  )
}

function ReasoningRow(props: { text: string; mode: "show" | "hide" | "collapsed"; streaming: boolean; durationMs?: number }) {
  const [expanded, setExpanded] = createSignal(false)
  const renderer = useRenderer()
  const summary = createMemo(() => truncate(reasoningSummary(props.text), 100))
  const open = () => props.mode === "show" || expanded()
  const duration = () => props.durationMs === undefined ? "" : ` · ${Math.max(0, props.durationMs / 1000).toFixed(1)}s`
  return (
    <Show when={props.mode !== "hide" && props.text.trim()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        {/* "show" is OpenCode's single muted block; a summary header would repeat the first line. */}
        <Show when={props.mode === "collapsed"} fallback={
          <code filetype="markdown" content={`_Thinking:_ ${props.text.trim()}`} streaming={props.streaming} syntaxStyle={syntax()} conceal fg={theme.textMuted} />
        }>
          <box onMouseUp={() => !renderer.getSelection()?.getSelectedText() && setExpanded((value) => !value)}>
            <text fg={theme.warning} wrapMode="none">
              {open() ? "- " : "+ "}Thought: {summary()}{duration()}
            </text>
          </box>
          <Show when={open()}>
            <box marginTop={1} paddingLeft={2}>
              <code filetype="markdown" content={props.text.trim()} streaming={props.streaming} syntaxStyle={syntax()} conceal fg={theme.textMuted} />
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

function ToolHeading(props: { tool: ToolCallTimelineItem; text: string; icon?: string; transcript?: boolean }) {
  const failed = () => props.tool.status === "failed"
  const running = () => props.tool.status === "running" && (!props.transcript || props.tool.detail.type === "read" || props.tool.detail.type === "sub_agent")
  const fg = () => (failed() ? theme.error : running() ? theme.text : theme.textMuted)
  return (
    <Show when={running()} fallback={
      <box flexDirection="row">
        <text width={props.transcript ? 2 : 3} fg={fg()} attributes={props.tool.status === "canceled" ? TextAttributes.STRIKETHROUGH : undefined}>{props.icon}</text>
        <text flexGrow={1} fg={fg()} attributes={props.tool.status === "canceled" ? TextAttributes.STRIKETHROUGH : undefined}>{props.text}</text>
      </box>
    }>
      <Spinner color={fg()}>{props.text}</Spinner>
    </Show>
  )
}

function ToolError(props: { tool: ToolCallTimelineItem }) {
  return (
    <Show when={props.tool.status === "failed"}>
      <text fg={theme.error}>{errorText(props.tool.error)}</text>
    </Show>
  )
}

// Ported from OpenCode 2.0.26 InlineTool/BlockTool (MIT); see render/OPENCODE-LICENSE.
function BlockTool(props: { tool: ToolCallTimelineItem; title?: string; path?: { label: string; value: string }; icon?: string; onClick?: () => void; children: JSX.Element; transcript?: boolean; onWidth?: (width: number) => void }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal(dimensions().width)
  const [hover, setHover] = createSignal(false)
  return (
    <box
      border={["left"]} customBorderChars={SplitBorder} borderColor={theme.background}
      onSizeChange={function () { setWidth(this.width); props.onWidth?.(this.width) }}
      backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
      paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={props.transcript ? 0 : 1} marginTop={props.transcript ? 0 : 1} gap={1} flexShrink={0}
      onMouseOver={() => props.onClick && setHover(true)} onMouseOut={() => setHover(false)}
      onMouseUp={() => !renderer.getSelection()?.getSelectedText() && props.onClick?.()}
    >
      <Show when={props.title}>
        <Show when={props.transcript} fallback={<ToolHeading tool={props.tool} text={props.title ?? ""} icon={props.icon ?? "#"} />}>
          <text fg={theme.textMuted}>{props.icon ? `${props.icon} ` : ""}{props.title}</text>
        </Show>
      </Show>
      <Show when={props.path}>{(path) => <box flexDirection="row" gap={1} minWidth={0}>
        <text flexShrink={0} fg={theme.textMuted}>{path().label}</text>
        <text wrapMode="none" truncate fg={theme.textMuted}>{truncateFilePath(path().value, Math.max(2, width() - 4 - Bun.stringWidth(path().label)))}</text>
      </box>}</Show>
      {props.children}
      <ToolError tool={props.tool} />
    </box>
  )
}

type ToolProps = { tool: ToolCallTimelineItem; separate: boolean; showDetails: boolean; diffStyle?: "unified" | "split" | "auto"; transcript?: boolean }
// Ported from OpenCode 2.0.26 per-tool dispatch/renderers (MIT); see render/OPENCODE-LICENSE.
function ToolRow(props: ToolProps) {
  const renderer = useRenderer()
  const [errorExpanded, setErrorExpanded] = createSignal(false)
  const summary = createMemo(() => toolSummary(props.tool))
  const inlineText = createMemo(() => {
    const detail = props.tool.detail
    const text = summary().text
    if (detail.type === "read") {
      if (!props.transcript) return text + [detail.offset !== undefined ? `offset=${detail.offset}` : "", detail.limit !== undefined ? `limit=${detail.limit}` : ""].filter(Boolean).map((part) => ` ${part}`).join("")
      const offset = detail.offset || 1
      return text + (detail.limit !== undefined || offset > 1 ? `:${offset}-${detail.limit ? offset + detail.limit - 1 : ""}` : "")
    }
    if (detail.type === "search") {
      const count = detail.numMatches ?? detail.numFiles ?? detail.webResults?.length ?? detail.filePaths?.length
      const label = detail.toolName === "web_search" ? "Web Search" : detail.toolName === "glob" ? "Glob" : detail.toolName === "grep" ? "Grep" : "Search"
      return `${label} "${detail.query}"${count === undefined || (props.transcript && (count === 0 || detail.toolName === "web_search")) ? "" : ` (${count} ${count === 1 ? "match" : "matches"})`}`
    }
    if (detail.type === "sub_agent") {
      if (props.transcript) return `${(detail.subAgentType ?? "General").replace(/(^|[-_ ])(\w)/g, (_, sep, letter: string) => `${sep ? " " : ""}${letter.toUpperCase()}`)} Subagent — ${detail.description ?? "Subagent"}`
      const count = detail.actions?.length ?? 0
      return text + ` (${count} ${count === 1 ? "action" : "actions"})`
    }
    if (detail.type === "plain_text" && detail.text && detail.text.trim() !== detail.label?.trim()) return `${text} ${truncate(detail.text.replace(/\s+/g, " "), 200)}`
    return text
  })
  return (
    <Switch fallback={
      <box paddingLeft={3} marginTop={props.separate ? 1 : 0} flexShrink={0}
        onMouseUp={() => props.transcript && props.tool.status === "failed" && !renderer.getSelection()?.getSelectedText() && setErrorExpanded((value) => !value)}>
        <ToolHeading tool={props.tool} text={inlineText()} transcript={props.transcript} icon={props.transcript && props.tool.detail.type === "sub_agent" && props.tool.status === "completed" ? "✓" : props.tool.detail.type === "search" && props.tool.detail.toolName === "web_search" ? "◈" : summary().icon} />
        <Show when={!props.transcript || errorExpanded() || props.showDetails}><box paddingLeft={props.transcript ? 2 : 3}><ToolError tool={props.tool} /></box></Show>
      </box>
    }>
      <Match when={props.tool.detail.type === "shell" && props.tool.detail}>
        {(detail) => <Shell tool={props.tool} detail={detail()} showDetails={props.showDetails} transcript={props.transcript} />}
      </Match>
      <Match when={props.tool.detail.type === "write" && (!props.transcript || props.tool.status === "completed") && props.tool.detail}>
        {(detail) => (
          <BlockTool tool={props.tool} title={props.transcript ? undefined : `Write ${detail().filePath}`} path={props.transcript ? { label: "# Wrote", value: detail().filePath } : undefined} icon="←" transcript={props.transcript}>
            <Show when={detail().content}>
              <line_number fg={theme.diffLineNumber} minWidth={3} paddingRight={1}>
                <code content={detail().content ?? ""} filetype={filetype(detail().filePath)} syntaxStyle={syntax()} fg={theme.text} conceal={false} />
              </line_number>
            </Show>
          </BlockTool>
        )}
      </Match>
      <Match when={props.tool.detail.type === "edit" && props.tool.detail}>
        {(detail) => <Edit tool={props.tool} detail={detail()} diffStyle={props.diffStyle} transcript={props.transcript} />}
      </Match>
      <Match when={props.tool.detail.type === "plan" && props.tool.detail}>
        {(detail) => (
          <BlockTool tool={props.tool} title="Plan" icon="◇" transcript={props.transcript}>
            <markdown content={detail().text} syntaxStyle={syntax()} streaming={props.tool.status === "running"} conceal fg={theme.markdownText} bg={theme.backgroundPanel} />
          </BlockTool>
        )}
      </Match>
      <Match when={props.tool.detail.type === "worktree_setup" && props.tool.detail}>
        {(detail) => <Worktree tool={props.tool} detail={detail()} showDetails={props.showDetails} transcript={props.transcript} />}
      </Match>
    </Switch>
  )
}

// Ported from OpenCode 2.0.26 ShellDisplay (MIT); see render/OPENCODE-LICENSE.
function Shell(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "shell" }>; showDetails: boolean; transcript?: boolean }) {
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal<number>()
  const [expanded, setExpanded] = createSignal<boolean>()
  createEffect(on(() => props.showDetails, () => setExpanded(undefined), { defer: true }))
  const open = () => expanded() ?? props.showDetails
  const output = createMemo(() => props.transcript ? Bun.stripANSI(props.detail.output ?? "").trim() : Bun.stripANSI(props.detail.output ?? "").trimEnd())
  const input = () => `${props.transcript && props.tool.status === "running" ? "" : "$ "}${props.transcript && props.detail.cwd && props.detail.cwd !== "." ? `cd ${props.detail.cwd} && ` : ""}${props.detail.command}`
  const collapsed = createMemo(() => props.transcript ? collapseShellOutput(input(), output(), 10, 10 * Math.max(20, (width() ?? dimensions().width) - 6 - (props.tool.status === "running" ? 2 : 0))) : { ...collapseToolOutput(output(), 10, 10 * Math.max(20, dimensions().width - 6)), input: input() })
  return (
    <BlockTool tool={props.tool} transcript={props.transcript} onWidth={setWidth} title={props.transcript ? undefined : props.detail.cwd ? `Running in ${props.detail.cwd}` : "Shell"} onClick={collapsed().overflow ? () => setExpanded(!open()) : undefined}>
      <Show when={props.transcript && props.tool.status === "running"} fallback={<text fg={theme.text} wrapMode={open() ? "word" : "char"} maxHeight={props.transcript && !open() ? 2 : undefined} attributes={props.tool.status === "canceled" ? TextAttributes.STRIKETHROUGH : undefined}>{open() ? input() : collapsed().input}</text>}>
        <box flexDirection="row" gap={1}>
          <Spinner color={theme.text} />
          <text fg={theme.text} flexGrow={1} minWidth={0} wrapMode={open() ? "word" : "char"} maxHeight={open() ? undefined : 2}>{open() ? input() : collapsed().input}</text>
        </box>
      </Show>
      <Show when={output()}><text fg={props.transcript ? theme.textMuted : theme.text}>{open() ? output() : collapsed().output}</text></Show>
      <Show when={collapsed().overflow && !props.transcript}><text fg={theme.textMuted}>{open() ? "Click to collapse" : "Click to expand"}</text></Show>
    </BlockTool>
  )
}

// Ported from OpenCode 2.0.26 Edit (MIT); see render/OPENCODE-LICENSE.
function Edit(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "edit" }>; diffStyle?: ToolProps["diffStyle"]; transcript?: boolean }) {
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal<number>()
  const diff = createMemo(() => editDiff(props.detail))
  const view = () => props.diffStyle === "split" || (props.diffStyle === "auto" && (props.transcript ? width() ?? dimensions().width : dimensions().width) > 120) ? "split" : "unified"
  return (
    <BlockTool tool={props.tool} title={props.transcript ? undefined : `Edit ${props.detail.filePath}`} path={props.transcript ? { label: "← Edit", value: props.detail.filePath } : undefined} onWidth={setWidth} icon="←" transcript={props.transcript}>
      <Show when={diff() && (!props.transcript || props.tool.status === "completed")}>
        <box paddingLeft={props.transcript ? 1 : 0}>
        <diff
          diff={diff()} view={view()} filetype={filetype(props.detail.filePath)} syntaxStyle={syntax()}
          width="100%" wrapMode="word" showLineNumbers fg={theme.text}
          addedBg={theme.diffAddedBg} removedBg={theme.diffRemovedBg} contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded} removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber} lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg} removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
        </box>
      </Show>
    </BlockTool>
  )
}

function Worktree(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "worktree_setup" }>; showDetails: boolean; transcript?: boolean }) {
  const [expanded, setExpanded] = createSignal<boolean>()
  createEffect(on(() => props.showDetails, () => setExpanded(undefined), { defer: true }))
  const open = () => expanded() ?? props.showDetails
  const output = createMemo(() => Bun.stripANSI(props.detail.log).trimEnd())
  const collapsed = createMemo(() => collapseToolOutput(output()))
  return (
    <BlockTool tool={props.tool} title={`Worktree ${props.detail.branchName}`} icon="⚙" transcript={props.transcript} onClick={collapsed().overflow ? () => setExpanded(!open()) : undefined}>
      <text fg={theme.textMuted}>{props.detail.worktreePath}</text>
      <For each={props.detail.commands}>
        {(command) => (
          <Show when={command.status === "running"} fallback={<text fg={command.status === "failed" ? theme.error : theme.textMuted}>$ {command.command}{command.exitCode === null ? "" : ` (exit ${command.exitCode})`}</text>}>
            <Spinner color={theme.text}>{command.command}</Spinner>
          </Show>
        )}
      </For>
      <Show when={output()}><text fg={theme.text}>{open() ? output() : collapsed().output}</text></Show>
      <Show when={collapsed().overflow}><text fg={theme.textMuted}>{open() ? "Click to collapse" : "Click to expand"}</text></Show>
    </BlockTool>
  )
}

type Choice = { label: string; response: AgentPermissionResponse; other?: boolean }
type Question = { question: string; header?: string; options: string[]; allowOther: boolean }

/** OpenCode-style permission prompt, also used for Claude's plan approval and questions. */
export function PermissionPrompt(props: {
  request: AgentPermissionRequest
  onRespond: (response: AgentPermissionResponse) => void
}) {
  const [selected, setSelected] = createSignal(0)
  const [answers, setAnswers] = createSignal<Record<string, string>>({})
  const [other, setOther] = createSignal(false)
  let otherInput: InputRenderable | undefined
  createEffect(on(() => props.request.id, () => {
    setSelected(0)
    setAnswers({})
    setOther(false)
  }))

  const questions = createMemo<Question[]>(() => {
    if (props.request.kind !== "question" || !Array.isArray(props.request.input?.questions)) return []
    return props.request.input.questions.filter((q): q is Record<string, unknown> => !!q && typeof q === "object" && !Array.isArray(q)).map((q) => ({
      question: String(q.question ?? ""),
      header: typeof q.header === "string" ? q.header : undefined,
      // Claude marks free text with allowOther, Codex with isOther; option-less questions are free text too.
      allowOther: q.allowOther === true || q.isOther === true || !Array.isArray(q.options) || q.options.length === 0,
      options: Array.isArray(q.options)
        ? q.options.map((o) => typeof o === "string" ? o : o && typeof o === "object" && typeof o.label === "string" ? o.label : "").filter(Boolean)
        : [],
    }))
  })
  // Paseo's answer map is keyed by header (Codex requires it; Claude accepts header or question text).
  const keyOf = (q: Question) => q.header || q.question
  const question = createMemo(() => questions().find((q) => !Object.hasOwn(answers(), keyOf(q))))

  const choices = createMemo<Choice[]>(() => {
    const q = question()
    if (q) return [
      ...q.options.map((label): Choice => ({ label, response: { behavior: "allow" } })),
      ...(q.allowOther ? [{ label: "Other…", other: true, response: { behavior: "allow" } } as Choice] : []),
    ]
    if (props.request.actions?.length)
      return props.request.actions.map((action) => ({
        label: action.label,
        response: { behavior: action.behavior, selectedActionId: action.id },
      }))
    return [
      { label: "Allow once", response: { behavior: "allow" } },
      ...(props.request.suggestions?.length
        ? [{ label: "Allow always", response: { behavior: "allow", updatedPermissions: props.request.suggestions } } as Choice]
        : []),
      { label: "Reject", response: { behavior: "deny", message: "Rejected by user" } },
    ]
  })

  function choose(choice: Choice | undefined) {
    if (!choice) return
    const q = question()
    if (!q) return props.onRespond(choice.response)
    if (choice.other) return setOther(true)
    answer(choice.label)
  }

  function answer(text: string) {
    const q = question()
    if (!q || !text.trim()) return
    const next = { ...answers(), [keyOf(q)]: text }
    setAnswers(next)
    setSelected(0)
    setOther(false)
    if (questions().every((item) => Object.hasOwn(next, keyOf(item)))) props.onRespond({ behavior: "allow", updatedInput: { answers: next } })
  }

  useKeyboard((key) => {
    if (dialog.isOpen || key.defaultPrevented) return
    if (other()) {
      if (key.name === "escape") {
        setOther(false)
        key.preventDefault()
      }
      return
    }
    const total = choices().length
    if ((key.name === "left" || key.name === "up" || (key.shift && key.name === "tab")) && total) setSelected((i) => (i - 1 + total) % total)
    else if ((key.name === "right" || key.name === "down" || key.name === "tab") && total) setSelected((i) => (i + 1) % total)
    else if (key.name === "return") choose(choices()[selected()])
    else if (key.name === "escape") props.onRespond({ behavior: "deny", message: "Rejected by user" })
    else return
    key.preventDefault()
  })

  const detail = createMemo(() => {
    const d = props.request.detail
    if (!d) return undefined
    return toolSummary({ type: "tool_call", callId: "", name: props.request.name, status: "running", error: null, detail: d })
  })
  const plan = () => (typeof props.request.metadata?.planText === "string" ? props.request.metadata.planText : undefined)
  const title = () => question()?.question ?? props.request.title ?? props.request.name

  return (
    <box border={["left"]} borderColor={theme.warning} customBorderChars={SplitBorder} flexShrink={0}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.backgroundPanel} gap={1}>
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          {question() ? "? Question" : props.request.kind === "plan" ? "◇ Plan ready" : "△ Permission required"}
        </text>
        <text fg={theme.text}>{title()}</text>
        <Show when={props.request.description && !question()}>
          <text fg={theme.textMuted}>{props.request.description}</text>
        </Show>
        <Show when={detail()}>
          {(d) => (
            <text fg={theme.textMuted}>
              {d().icon} {truncate(d().text, 300)}
            </text>
          )}
        </Show>
        <Show when={plan()}>
          {(text) => (
            <scrollbox height={Math.min(16, text().split("\n").length + 1)} scrollbarOptions={{ visible: false }}>
              <markdown syntaxStyle={syntax()} content={text()} conceal fg={theme.text} bg={theme.backgroundPanel} />
            </scrollbox>
          )}
        </Show>
        <Show when={other()} fallback={<box flexDirection="row" gap={1} flexWrap="wrap">
          <For each={choices()}>
            {(choice, index) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={index() === selected() ? theme.warning : theme.backgroundElement}
                onMouseUp={() => choose(choice)}
              >
                <text fg={index() === selected() ? theme.selectedListItemText : theme.textMuted}>{choice.label}</text>
              </box>
            )}
          </For>
        </box>}>
          <input
            ref={(input: InputRenderable) => (otherInput = input)}
            focused={!dialog.isOpen} placeholder="Your answer…" onSubmit={() => answer(otherInput?.value ?? "")}
            textColor={theme.text} focusedTextColor={theme.text} cursorColor={theme.text}
            backgroundColor={theme.backgroundElement} focusedBackgroundColor={theme.backgroundElement}
            placeholderColor={theme.textMuted}
          />
        </Show>
        <text fg={theme.textMuted}>
          <Show when={other()} fallback={<><span style={{ fg: theme.text }}>⇆</span> select <span style={{ fg: theme.text }}>enter</span> confirm <span style={{ fg: theme.text }}>esc</span> reject</>}>
            <span style={{ fg: theme.text }}>enter</span> submit <span style={{ fg: theme.text }}>esc</span> back
          </Show>
        </text>
      </box>
    </box>
  )
}
