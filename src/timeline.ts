import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types"

export type { AgentTimelineItem, ToolCallTimelineItem }

/** Folds one live timeline item into the rendered rows. Mutates `rows` (works on plain arrays and Solid `produce` drafts). */
export function applyTimelineItem(rows: AgentTimelineItem[], item: AgentTimelineItem) {
  if (item.type === "tool_call") {
    const index = rows.findLastIndex((row) => row.type === "tool_call" && row.callId === item.callId)
    if (index >= 0) {
      const previous = rows[index] as typeof item
      // Claude's final Task event reverts to an unknown detail; keep the sub_agent one streamed before it.
      rows[index] = item.detail.type === "unknown" && previous.detail.type !== "unknown" ? ({ ...item, detail: previous.detail } as typeof item) : item
      return
    }
  }
  // A compaction streams as loading then completed; keep one row.
  if (item.type === "compaction" && item.status === "completed") {
    const index = rows.findLastIndex((row) => row.type === "compaction" && row.status === "loading")
    if (index >= 0) {
      rows[index] = item
      return
    }
  }
  // Streaming text arrives as deltas; join them onto the message they belong to.
  const last = rows.at(-1)
  if (item.type === "reasoning" && last?.type === "reasoning") {
    last.text += item.text
    return
  }
  if (
    item.type === "assistant_message" &&
    last?.type === "assistant_message" &&
    (!item.messageId || !last.messageId || item.messageId === last.messageId)
  ) {
    last.text += item.text
    return
  }
  rows.push(item)
}

/** OpenCode-style one-line tool summary: icon plus what the tool touched. */
export function toolSummary(item: ToolCallTimelineItem): { icon: string; text: string } {
  const detail = item.detail
  switch (detail.type) {
    case "shell":
      return { icon: "$", text: detail.command }
    case "read":
      return { icon: "→", text: `Read ${detail.filePath}` }
    case "edit":
      return { icon: "←", text: `Edit ${detail.filePath}` }
    case "write":
      return { icon: "←", text: `Write ${detail.filePath}` }
    case "search":
      return { icon: "✱", text: `${titlecase(detail.toolName ?? "search")} "${detail.query}"` }
    case "fetch":
      return { icon: "%", text: `WebFetch ${detail.url}` }
    case "sub_agent":
      return { icon: "│", text: `${detail.subAgentType ?? "Task"} ${detail.description ?? ""}`.trim() }
    case "worktree_setup":
      return { icon: "⚙", text: `Worktree ${detail.branchName}` }
    case "plan":
      return { icon: "◇", text: "Plan" }
    case "plain_text":
      return { icon: "⚙", text: detail.label ?? item.name }
    default:
      return { icon: "⚙", text: item.name }
  }
}

/** Groups like OpenCode's session list: "Today", otherwise the date. */
export function dayCategory(iso: string, now = new Date()) {
  const label = new Date(iso).toDateString()
  return label === now.toDateString() ? "Today" : label
}

/** History pages keep a compaction's "loading" entry next to its "completed" one; drop the stale one. */
export function dropStaleCompactions<T extends { item: AgentTimelineItem }>(entries: T[]) {
  return entries.filter(
    (entry, index) =>
      !(entry.item.type === "compaction" && entry.item.status === "loading" && entries.slice(index + 1).some((next) => next.item.type === "compaction")),
  )
}

/** Claude tool errors arrive as raw tool_result blocks; show their text. */
export function errorText(error: unknown): string {
  if (typeof error === "string") {
    if (!error.startsWith("{")) return error
    try {
      return errorText(JSON.parse(error))
    } catch {
      return error
    }
  }
  if (error && typeof error === "object" && "content" in error) {
    const content = error.content
    if (typeof content === "string") return content.trim()
    if (Array.isArray(content)) return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n").trim()
  }
  return error == null ? "Tool failed" : JSON.stringify(error)
}

/** Forks start with the daemon's <chat-history-summary> block; show it as one line. */
export function collapseForkContext(text: string) {
  return text.replace(/<chat-history-summary>[\s\S]*?<\/chat-history-summary>\s*/, (block) => {
    const source = block.match(/^Source agent: (.*)$/m)?.[1]
    return `↳ forked from ${source ?? "another session"}\n\n`
  })
}

/** First line-ish of free text for one-row lists. */
export function truncateLine(value: string, max: number) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

function titlecase(value: string) {
  return value.replace(/(^|_)(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase())
}
