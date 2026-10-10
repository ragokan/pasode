// Provenance: OpenCode MIT sidebar/files.tsx presentation; Paseo timeline aggregation authored for pasode.
import path from "node:path"
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types"

export type FileChange = { file: string; additions: number; deletions: number }

function lines(text: string) {
  return text ? text.replace(/\r?\n$/, "").split("\n").length : 0
}

export function diffCounts(diff: string) {
  let additions = 0
  let deletions = 0
  let hunk = false
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) hunk = false
    if (line.startsWith("@@ ")) hunk = true
    if (!hunk) continue
    if (line.startsWith("+")) additions++
    if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export function aggregateFiles(rows: readonly AgentTimelineItem[], cwd: string): FileChange[] {
  const calls = new Map(rows.filter((row) => row.type === "tool_call").map((row) => [row.callId, row]))
  const files = new Map<string, FileChange>()
  for (const call of calls.values()) {
    if (call.status !== "completed") continue
    const detail = call.detail
    if (detail.type !== "edit" && detail.type !== "write") continue
    const file = path.relative(cwd, path.resolve(cwd, detail.filePath))
    const counts = detail.type === "edit"
      ? detail.unifiedDiff !== undefined ? diffCounts(detail.unifiedDiff)
        : { additions: lines(detail.newString ?? ""), deletions: lines(detail.oldString ?? "") }
      // shortcut: write events have no old content; obtain a baseline diff if exact removed-line counts are needed.
      : { additions: lines(detail.content ?? ""), deletions: 0 }
    const entry = files.get(file) ?? { file, additions: 0, deletions: 0 }
    entry.additions += counts.additions
    entry.deletions += counts.deletions
    files.set(file, entry)
  }
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file))
}
