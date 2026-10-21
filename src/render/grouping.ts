import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types"

export type Verbosity = "low" | "medium" | "high"
export type Grouping = "auto" | "none"
export type GroupKind = "activity" | "reasoning" | "exploration"
export type TranscriptNode = { type: "entry"; index: number } | {
  type: "group"; index: number; kind: GroupKind; children: TranscriptNode[]; indices: number[]
}

// Ported from OpenCode 2.0.26 grouping/session.ts (MIT); see OPENCODE-LICENSE.
export function toolName(item: AgentTimelineItem): string {
  if (item.type === "todo") return "todo"
  if (item.type !== "tool_call") return ""
  if (/^(question|askuserquestion|request_user_input)$/i.test(item.name)) return "question"
  const detail = item.detail
  if (detail.type === "search") return detail.toolName === "web_search" ? "websearch" : detail.toolName === "search" || !detail.toolName ? "grep" : detail.toolName
  if (detail.type === "fetch") return "webfetch"
  if (detail.type === "sub_agent") return "subagent"
  return detail.type === "unknown" ? item.name.toLowerCase() : detail.type
}

const explorationTools = new Set(["read", "glob", "grep", "webfetch", "websearch"])

// Ported from OpenCode 2.0.26 grouping/session.ts partPath (MIT); see OPENCODE-LICENSE.
export function partPath(item: AgentTimelineItem, verbosity: Verbosity): GroupKind[] {
  if (toolName(item) === "question" || (item.type === "tool_call" && item.agentMessage)) return []
  const part = item.type === "reasoning" || item.type === "tool_call" || item.type === "todo"
  const activity: GroupKind[] = verbosity === "low" && part ? ["activity"] : []
  if (item.type === "reasoning") return [...activity, "reasoning"]
  if (explorationTools.has(toolName(item))) return [...activity, "exploration"]
  return activity
}

// Ported from OpenCode 2.0.26 grouping/tree.ts groupEntries (MIT); see OPENCODE-LICENSE.
export function groupTranscript(rows: readonly AgentTimelineItem[], verbosity: Verbosity): TranscriptNode[] {
  const result: TranscriptNode[] = []
  rows.forEach((item, index) => {
    let children = result
    for (const kind of partPath(item, verbosity)) {
      const previous = children.at(-1)
      const group = previous?.type === "group" && previous.kind === kind ? previous : {
        type: "group" as const, index, kind, children: [], indices: [],
      }
      if (group !== previous) children.push(group)
      group.indices.push(index)
      children = group.children
    }
    children.push({ type: "entry", index })
  })
  return result
}

// Ported from OpenCode routes/session/mount-budget.ts rowsBefore (MIT); see OPENCODE-LICENSE.
/** First index such that nodes [index, end) spend at least `budget`. */
export function nodesBefore(weights: readonly number[], end: number, budget: number) {
  let index = end
  let spent = 0
  while (index > 0 && spent < budget) spent += weights[--index]!
  return index
}

// Ported from OpenCode 2.0.26 activity-summary.ts (MIT); see OPENCODE-LICENSE.
export function activitySummary(rows: readonly AgentTimelineItem[], indices: readonly number[], running: boolean) {
  const counts = { command: 0, edit: 0, thought: 0, read: 0, tool: 0 }
  let active = false
  let busy = ""
  indices.forEach((index) => {
    const item = rows[index]!
    if (item.type === "reasoning") {
      if (!reasoningContent(item.text)) return
      if (running && index === rows.length - 1) {
        active = true
        busy ||= "Thinking…"
      } else counts.thought++
      return
    }
    if (item.type === "tool_call" && item.status === "running") {
      active = true
      busy ||= `Running ${toolName(item) === "shell" ? "command" : toolName(item)}…`
      return
    }
    const name = toolName(item)
    if (name === "shell") counts.command++
    else if (name === "edit" || name === "write" || name === "patch") counts.edit++
    else if (name === "read") counts.read++
    else if (name) counts.tool++
  })
  const label = Object.entries(counts).filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`).join(", ")
  return { label: label || busy, active }
}

// Ported from OpenCode 2.0.26 message-parts.tsx reasoningContent (MIT); see OPENCODE-LICENSE.
export function reasoningContent(text: string) {
  return text.replace("[REDACTED]", "").trim()
}

// Ported from OpenCode 2.0.26 context/thinking.ts reasoningSummary (MIT); see OPENCODE-LICENSE.
export function reasoningTitle(text: string): string | null {
  return reasoningContent(text).match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)?.[1]?.trim() ?? null
}

// Ported from OpenCode 2.0.26 group-view.tsx exploration labels (MIT); see OPENCODE-LICENSE.
export function explorationSummary(rows: readonly AgentTimelineItem[], indices: readonly number[], running: boolean) {
  const counts: Record<string, number> = {}
  indices.forEach((index) => {
    const tool = toolName(rows[index]!)
    const name = ["grep", "glob", "websearch"].includes(tool) ? "search" : tool === "webfetch" ? "fetch" : tool
    counts[name] = (counts[name] ?? 0) + 1
  })
  const completed = !running || indices.at(-1)! < rows.length - 1 || indices.every((index) => {
    const item = rows[index]!
    return item.type === "tool_call" && item.status !== "running"
  })
  const label = Object.entries(counts).map(([name, count]) => `${count} ${count === 1 ? name : ["search", "fetch"].includes(name) ? `${name}es` : `${name}s`}`).join(", ")
  return { label: `${completed ? "Explored" : "Exploring"}: ${label}`, completed }
}
