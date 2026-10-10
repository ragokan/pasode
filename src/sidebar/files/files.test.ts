// Provenance: pasode-authored checks for Paseo aggregation; presentation derives from OpenCode sidebar/files.tsx.
import { expect, test } from "bun:test"
import type { ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types"
import { aggregateFiles, diffCounts } from "./files"

const call = (callId: string, detail: ToolCallDetail, status: "running" | "completed" | "canceled" = "completed"): ToolCallTimelineItem => ({
  type: "tool_call", callId, name: detail.type, detail, status, error: null,
})

test("unified diffs ignore headers and count +++/--- inside hunks", () => {
  expect(diffCounts("--- a/file\n+++ b/file\n@@ -1,2 +1,3 @@\n-old\n+new\n+++literal\n---literal\n unchanged\n+extra\n"))
    .toEqual({ additions: 3, deletions: 2 })
})

test("fold latest call state, aggregate relative paths, skip unsuccessful calls", () => {
  const edit: ToolCallDetail = { type: "edit", filePath: "/project/src/a.ts", oldString: "old\n", newString: "one\ntwo\n" }
  expect(aggregateFiles([
    call("1", edit, "running"), call("1", edit),
    call("2", { type: "edit", filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n-one\n+three" }),
    call("3", { type: "write", filePath: "b.ts", content: "x\ny\n" }),
    call("4", { type: "write", filePath: "empty.ts", content: "" }),
    call("5", { type: "write", filePath: "canceled", content: "no" }, "canceled"),
    call("6", { type: "read", filePath: "read-only" }),
    { ...call("7", edit), status: "failed", error: "failed" },
  ], "/project")).toEqual([
    { file: "b.ts", additions: 2, deletions: 0 },
    { file: "empty.ts", additions: 0, deletions: 0 },
    { file: "src/a.ts", additions: 3, deletions: 2 },
  ])
})

test("empty diffs do not fall back to replacement counts, paths can be outside cwd", () => {
  expect(aggregateFiles([
    call("1", { type: "edit", filePath: "../a", unifiedDiff: "", oldString: "old", newString: "new" }),
  ], "/project")).toEqual([{ file: "../a", additions: 0, deletions: 0 }])
})
