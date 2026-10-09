import type { AgentTimelineItem, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types"
import { expect, test } from "bun:test"
import { activitySummary, explorationSummary, groupTranscript, partPath, reasoningTitle } from "./grouping"

function tool(detail: ToolCallDetail): ToolCallTimelineItem {
  return { type: "tool_call", name: detail.type, callId: detail.type, status: "completed", error: null, detail }
}

test("low groups runs of activity, retains nested exploration/reasoning, and never groups prompts/text/questions", () => {
  const rows: AgentTimelineItem[] = [
    { type: "user_message", text: "Hi" }, { type: "reasoning", text: "Think" },
    tool({ type: "shell", command: "pwd" }), tool({ type: "read", filePath: "a.ts" }),
    tool({ type: "search", query: "needle", toolName: "grep" }), { type: "assistant_message", text: "Done" },
    { ...tool({ type: "unknown", input: {}, output: {} }), name: "AskUserQuestion" } as AgentTimelineItem,
  ]
  expect(groupTranscript(rows, "low")).toEqual([
    { type: "entry", index: 0 },
    { type: "group", kind: "activity", index: 1, indices: [1, 2, 3, 4], children: [
      { type: "group", kind: "reasoning", index: 1, indices: [1], children: [{ type: "entry", index: 1 }] },
      { type: "entry", index: 2 },
      { type: "group", kind: "exploration", index: 3, indices: [3, 4], children: [{ type: "entry", index: 3 }, { type: "entry", index: 4 }] },
    ] },
    { type: "entry", index: 5 }, { type: "entry", index: 6 },
  ])
})

test.each(["medium", "high"] as const)("%s shares production grouping paths without an activity wrapper", (verbosity) => {
  expect(partPath({ type: "reasoning", text: "Think" }, verbosity)).toEqual(["reasoning"])
  expect(partPath(tool({ type: "read", filePath: "a" }), verbosity)).toEqual(["exploration"])
  expect(partPath(tool({ type: "shell", command: "pwd" }), verbosity)).toEqual([])
})

test("activity nouns/order match OpenCode, including generic tools and redacted thoughts", () => {
  const rows = [
    tool({ type: "read", filePath: "a" }), tool({ type: "shell", command: "pwd" }),
    tool({ type: "write", filePath: "b", content: "x" }), { type: "reasoning" as const, text: "Think" },
    { type: "reasoning" as const, text: "[REDACTED]" }, tool({ type: "search", query: "x" }),
    tool({ type: "fetch", url: "https://example.com" }), tool({ type: "sub_agent", log: "" }),
    { type: "todo" as const, items: [] }, tool({ type: "plan", text: "Next" }),
  ]
  expect(activitySummary(rows, rows.map((_, i) => i), false)).toEqual({ label: "1 command, 1 edit, 1 thought, 1 read, 5 tools", active: false })
})

test("activity counts only finished work; live thoughts close when a later row arrives", () => {
  const running = { ...tool({ type: "shell", command: "pwd" }), status: "running" as const, error: null }
  expect(activitySummary([running], [0], true)).toEqual({ label: "Running command…", active: true })
  const thought: AgentTimelineItem = { type: "reasoning", text: "Think" }
  expect(activitySummary([thought], [0], true)).toEqual({ label: "Thinking…", active: true })
  expect(activitySummary([thought, { type: "assistant_message", text: "Done" }], [0], true)).toEqual({ label: "1 thought", active: false })
})

test("exploration groups search/fetch nouns and uses terminal tool statuses", () => {
  const rows = [tool({ type: "read", filePath: "a" }), tool({ type: "search", query: "x", toolName: "glob" }), tool({ type: "search", query: "y", toolName: "web_search" }), tool({ type: "fetch", url: "u" }), tool({ type: "fetch", url: "v" })]
  expect(explorationSummary(rows, [0, 1, 2, 3, 4], true)).toEqual({ label: "Explored: 1 read, 2 searches, 2 fetches", completed: true })
})

test("reasoning disclosure metadata only recognizes OpenAI's complete bold title block", () => {
  expect(reasoningTitle("**Inspecting code**\n\nDetails")).toBe("Inspecting code")
  expect(reasoningTitle("**Inspecting code**")).toBe("Inspecting code")
  expect(reasoningTitle("First line\nBody")).toBeNull()
  expect(reasoningTitle("# Heading\nBody")).toBeNull()
  expect(reasoningTitle("**Unfinished")).toBeNull()
})
