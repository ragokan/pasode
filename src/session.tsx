import type { AgentPermissionRequest, AgentPermissionResponse, ToolCallDetail } from "@getpaseo/protocol/agent-types"
import { TextAttributes, type InputRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { dialog, truncate } from "./dialog"
import { collapseToolOutput, editDiff, filetype, reasoningSummary, timestampLabel } from "./render/helpers"
import { collapseForkContext, errorText, toolSummary, type AgentTimelineItem, type ToolCallTimelineItem } from "./timeline"
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
}) {
  const item = () => props.item
  return (
    <Switch>
      <Match when={item().type === "user_message" && (item() as Extract<AgentTimelineItem, { type: "user_message" }>)}>
        {(message) => (
          <box border={["left"]} borderColor={theme.secondary} customBorderChars={SplitBorder} marginTop={1} flexShrink={0}>
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
            <box paddingLeft={3} marginTop={1} flexShrink={0}>
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
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
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
          <box border={["left"]} borderColor={theme.error} customBorderChars={SplitBorder} marginTop={1} flexShrink={0}>
            <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={theme.backgroundPanel}>
              <text fg={theme.textMuted}>{error().message}</text>
            </box>
          </box>
        )}
      </Match>
      <Match when={item().type === "notification" && (item() as Extract<AgentTimelineItem, { type: "notification" }>)}>
        {(note) => (
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <text fg={note().level === "error" ? theme.error : note().level === "warning" ? theme.warning : theme.textMuted}>{note().message}</text>
          </box>
        )}
      </Match>
      <Match when={item().type === "compaction" && (item() as Extract<AgentTimelineItem, { type: "compaction" }>)}>
        {(compaction) => (
          <box marginTop={1} border={["top"]} title={compaction().status === "loading" ? " Compacting… " : " Compaction "} titleAlignment="center" borderColor={theme.textMuted} flexShrink={0} />
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

function ToolHeading(props: { tool: ToolCallTimelineItem; text: string; icon?: string }) {
  const failed = () => props.tool.status === "failed"
  const running = () => props.tool.status === "running"
  const fg = () => (failed() ? theme.error : running() ? theme.text : theme.textMuted)
  return (
    <Show when={running()} fallback={
      <box flexDirection="row">
        <text width={3} fg={fg()} attributes={props.tool.status === "canceled" ? TextAttributes.STRIKETHROUGH : undefined}>{props.icon}</text>
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

function BlockTool(props: { tool: ToolCallTimelineItem; title: string; icon?: string; onClick?: () => void; children: JSX.Element }) {
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  return (
    <box
      border={["left"]} customBorderChars={SplitBorder} borderColor={theme.background}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1} marginTop={1} gap={1} flexShrink={0}
      onMouseOver={() => props.onClick && setHover(true)} onMouseOut={() => setHover(false)}
      onMouseUp={() => !renderer.getSelection()?.getSelectedText() && props.onClick?.()}
    >
      <ToolHeading tool={props.tool} text={props.title} icon={props.icon ?? "#"} />
      {props.children}
      <ToolError tool={props.tool} />
    </box>
  )
}

type ToolProps = { tool: ToolCallTimelineItem; separate: boolean; showDetails: boolean; diffStyle?: "unified" | "split" | "auto" }
function ToolRow(props: ToolProps) {
  const summary = createMemo(() => toolSummary(props.tool))
  const inlineText = createMemo(() => {
    const detail = props.tool.detail
    const text = summary().text
    if (detail.type === "read") return text + [detail.offset !== undefined ? `offset=${detail.offset}` : "", detail.limit !== undefined ? `limit=${detail.limit}` : ""].filter(Boolean).map((part) => ` ${part}`).join("")
    if (detail.type === "search") {
      const count = detail.numMatches ?? detail.numFiles ?? detail.webResults?.length ?? detail.filePaths?.length
      const label = detail.toolName === "web_search" ? "Web Search" : detail.toolName === "glob" ? "Glob" : detail.toolName === "grep" ? "Grep" : "Search"
      return `${label} "${detail.query}"${count === undefined ? "" : ` (${count} ${count === 1 ? "match" : "matches"})`}`
    }
    if (detail.type === "sub_agent") {
      const count = detail.actions?.length ?? 0
      return text + ` (${count} ${count === 1 ? "action" : "actions"})`
    }
    if (detail.type === "plain_text" && detail.text) return `${text} ${truncate(detail.text.replace(/\s+/g, " "), 200)}`
    return text
  })
  return (
    <Switch fallback={
      <box paddingLeft={3} marginTop={props.separate ? 1 : 0} flexShrink={0}>
        <ToolHeading tool={props.tool} text={inlineText()} icon={props.tool.detail.type === "search" && props.tool.detail.toolName === "web_search" ? "◈" : summary().icon} />
        <box paddingLeft={3}><ToolError tool={props.tool} /></box>
      </box>
    }>
      <Match when={props.tool.detail.type === "shell" && props.tool.detail}>
        {(detail) => <Shell tool={props.tool} detail={detail()} showDetails={props.showDetails} />}
      </Match>
      <Match when={props.tool.detail.type === "write" && props.tool.detail}>
        {(detail) => (
          <BlockTool tool={props.tool} title={`Write ${detail().filePath}`} icon="←">
            <Show when={detail().content}>
              <line_number fg={theme.diffLineNumber} minWidth={3} paddingRight={1}>
                <code content={detail().content ?? ""} filetype={filetype(detail().filePath)} syntaxStyle={syntax()} fg={theme.text} conceal={false} />
              </line_number>
            </Show>
          </BlockTool>
        )}
      </Match>
      <Match when={props.tool.detail.type === "edit" && props.tool.detail}>
        {(detail) => <Edit tool={props.tool} detail={detail()} diffStyle={props.diffStyle} />}
      </Match>
      <Match when={props.tool.detail.type === "plan" && props.tool.detail}>
        {(detail) => (
          <BlockTool tool={props.tool} title="Plan" icon="◇">
            <markdown content={detail().text} syntaxStyle={syntax()} streaming={props.tool.status === "running"} conceal fg={theme.markdownText} bg={theme.backgroundPanel} />
          </BlockTool>
        )}
      </Match>
      <Match when={props.tool.detail.type === "worktree_setup" && props.tool.detail}>
        {(detail) => <Worktree tool={props.tool} detail={detail()} showDetails={props.showDetails} />}
      </Match>
    </Switch>
  )
}

function Shell(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "shell" }>; showDetails: boolean }) {
  const dimensions = useTerminalDimensions()
  const [expanded, setExpanded] = createSignal<boolean>()
  createEffect(on(() => props.showDetails, () => setExpanded(undefined), { defer: true }))
  const open = () => expanded() ?? props.showDetails
  const output = createMemo(() => Bun.stripANSI(props.detail.output ?? "").trimEnd())
  const collapsed = createMemo(() => collapseToolOutput(output(), 10, 10 * Math.max(20, dimensions().width - 6)))
  return (
    <BlockTool tool={props.tool} title={props.detail.cwd ? `Running in ${props.detail.cwd}` : "Shell"} onClick={collapsed().overflow ? () => setExpanded(!open()) : undefined}>
      <text fg={theme.text} attributes={props.tool.status === "canceled" ? TextAttributes.STRIKETHROUGH : undefined}>$ {props.detail.command}</text>
      <Show when={output()}><text fg={theme.text}>{open() ? output() : collapsed().output}</text></Show>
      <Show when={collapsed().overflow}><text fg={theme.textMuted}>{open() ? "Click to collapse" : "Click to expand"}</text></Show>
    </BlockTool>
  )
}

function Edit(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "edit" }>; diffStyle?: ToolProps["diffStyle"] }) {
  const dimensions = useTerminalDimensions()
  const diff = createMemo(() => editDiff(props.detail))
  const view = () => props.diffStyle === "split" || (props.diffStyle === "auto" && dimensions().width > 120) ? "split" : "unified"
  return (
    <BlockTool tool={props.tool} title={`Edit ${props.detail.filePath}`} icon="←">
      <Show when={diff()}>
        <diff
          diff={diff()} view={view()} filetype={filetype(props.detail.filePath)} syntaxStyle={syntax()}
          width="100%" wrapMode="word" showLineNumbers fg={theme.text}
          addedBg={theme.diffAddedBg} removedBg={theme.diffRemovedBg} contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded} removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber} lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg} removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </Show>
    </BlockTool>
  )
}

function Worktree(props: { tool: ToolCallTimelineItem; detail: Extract<ToolCallDetail, { type: "worktree_setup" }>; showDetails: boolean }) {
  const [expanded, setExpanded] = createSignal<boolean>()
  createEffect(on(() => props.showDetails, () => setExpanded(undefined), { defer: true }))
  const open = () => expanded() ?? props.showDetails
  const output = createMemo(() => Bun.stripANSI(props.detail.log).trimEnd())
  const collapsed = createMemo(() => collapseToolOutput(output()))
  return (
    <BlockTool tool={props.tool} title={`Worktree ${props.detail.branchName}`} icon="⚙" onClick={collapsed().overflow ? () => setExpanded(!open()) : undefined}>
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
