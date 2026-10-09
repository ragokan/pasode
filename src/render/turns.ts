import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types"
import type { Mark } from "../paseo"

export type TurnFooter = { index: number; duration: number; tps?: number; interrupted: boolean; error?: string }

// Adapted from OpenCode 2.0.26 rows.ts terminal footer/turn timing (MIT); see OPENCODE-LICENSE.
export function turnFooters(rows: readonly AgentTimelineItem[], times: readonly number[], marks: readonly Mark[], running: boolean): Map<number, TurnFooter> {
  const result = new Map<number, TurnFooter>()
  const users = rows.flatMap((item, index) => item.type === "user_message" ? [index] : [])
  let cursor = 0
  users.forEach((start, turn) => {
    const next = users[turn + 1] ?? rows.length
    if (next === rows.length && running) return
    if (next <= start + 1) return
    const at = times[start]!
    const boundary = times[next] ?? Infinity
    while (cursor < marks.length && marks[cursor]!.at < at) cursor++
    const markStart = cursor
    while (cursor < marks.length && marks[cursor]!.at < boundary) cursor++
    const turnMarks = marks.slice(markStart, cursor)
    const completion = turnMarks.findLast((mark): mark is Extract<Mark, { kind: "turn_completed" }> => mark.kind === "turn_completed")
    const end = completion?.at ?? times[next - 1]!
    const firstOutput = turnMarks.find((mark) => mark.kind === "item" && mark.at <= end && ["assistant_message", "reasoning"].includes(mark.type))
    const turnRows = rows.slice(start + 1, next)
    const outputIndex = turnRows.findIndex((item) => ["assistant_message", "reasoning"].includes(item.type))
    const streamed = firstOutput?.at ?? (outputIndex === -1 ? undefined : times[start + 1 + outputIndex])
    const tokens = completion?.outputTokens
    const error = turnRows.findLast((item) => item.type === "error")
    const terminal = turnRows.findLast((item) => item.type !== "notification" && item.type !== "compaction")
    const interrupted = (error?.type === "error" && /^(Step interrupted|Turn interrupted|Interrupted|Canceled|Cancelled)$/i.test(error.message)) || (!error && terminal?.type === "tool_call" && terminal.status === "canceled")
    result.set(next - 1, {
      index: next - 1,
      duration: Math.max(0, end - at),
      tps: tokens !== undefined && tokens > 0 && streamed !== undefined && end > streamed ? speed(tokens, end - at - toolTime(turnMarks, end)) : undefined,
      interrupted,
      error: error?.type === "error" && !interrupted ? error.message : undefined,
    })
  })
  return result
}

// OpenCode sums each step's provider time (created → streamed), which leaves out tools running between steps.
// Paseo has no steps, so take the turn's time minus the union of tool runs (running → terminal status marks).
function toolTime(marks: readonly Mark[], end: number) {
  const started = new Map<string, number>()
  const runs: [number, number][] = []
  for (const mark of marks) {
    if (mark.kind !== "item" || mark.type !== "tool_call" || !mark.callId) continue
    if (mark.status === "running") {
      if (!started.has(mark.callId)) started.set(mark.callId, mark.at)
      continue
    }
    const from = started.get(mark.callId)
    if (from === undefined) continue
    runs.push([from, Math.min(mark.at, end)])
    started.delete(mark.callId)
  }
  let total = 0
  let reached = -Infinity
  for (const [from, to] of runs.toSorted((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(from, reached))
    reached = Math.max(reached, to)
  }
  return total
}

const speed = (tokens: number, ms: number) => (ms > 0 ? tokens / (ms / 1000) : undefined)

// Ported from OpenCode 2.0.26 util/locale.ts duration (MIT); see OPENCODE-LICENSE.
export function durationLabel(ms: number) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  return `${Math.floor(ms / 86400000)}d ${Math.floor((ms % 86400000) / 3600000)}h`
}
