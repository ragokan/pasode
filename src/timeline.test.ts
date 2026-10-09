import { expect, test } from "bun:test"
import { applyTimelineItem, collapseForkContext, dayCategory, dropStaleCompactions, errorText, imageFile, toolSummary, type AgentTimelineItem } from "./timeline"

test("joins streamed assistant and reasoning deltas", () => {
  const rows: AgentTimelineItem[] = []
  applyTimelineItem(rows, { type: "reasoning", text: "Think" })
  applyTimelineItem(rows, { type: "reasoning", text: "ing" })
  applyTimelineItem(rows, { type: "assistant_message", text: "Hel", messageId: "m1" })
  applyTimelineItem(rows, { type: "assistant_message", text: "lo", messageId: "m1" })
  applyTimelineItem(rows, { type: "assistant_message", text: "Next", messageId: "m2" })
  expect(rows).toEqual([
    { type: "reasoning", text: "Thinking" },
    { type: "assistant_message", text: "Hello", messageId: "m1" },
    { type: "assistant_message", text: "Next", messageId: "m2" },
  ])
})

test("updates a tool call in place by callId", () => {
  const rows: AgentTimelineItem[] = [{ type: "user_message", text: "ls" }]
  const running = { type: "tool_call", callId: "t1", name: "Bash", status: "running", error: null, detail: { type: "shell", command: "ls" } } as const
  applyTimelineItem(rows, running)
  applyTimelineItem(rows, { type: "assistant_message", text: "ok" })
  applyTimelineItem(rows, { ...running, status: "completed", detail: { type: "shell", command: "ls", output: "a" } })
  expect(rows).toHaveLength(3)
  expect(rows[1]).toMatchObject({ status: "completed", detail: { output: "a" } })
})

test("tool summaries and day categories", () => {
  expect(toolSummary({ type: "tool_call", callId: "x", name: "Grep", status: "completed", error: null, detail: { type: "search", query: "foo", toolName: "web_search" } })).toEqual({ icon: "✱", text: 'Web Search "foo"' })
  const now = new Date("2026-10-09T12:00:00")
  expect(dayCategory("2026-10-09T08:00:00", now)).toBe("Today")
  expect(dayCategory("2026-10-08T08:00:00", now)).toBe(new Date("2026-10-08T08:00:00").toDateString())
})

test("merges a compaction's loading and completed rows", () => {
  const rows: AgentTimelineItem[] = []
  applyTimelineItem(rows, { type: "compaction", status: "loading" })
  applyTimelineItem(rows, { type: "compaction", status: "completed", trigger: "manual" })
  expect(rows).toEqual([{ type: "compaction", status: "completed", trigger: "manual" }])
})

test("readable tool errors and collapsed fork context", () => {
  const raw = '{"type":"tool_result","content":"File does not exist.\\n","is_error":true}'
  expect(errorText(raw)).toBe("File does not exist.")
  expect(errorText({ content: [{ type: "text", text: "boom" }] })).toBe("boom")
  expect(errorText("plain")).toBe("plain")
  const forked = "<chat-history-summary>\nChat history\nSource agent: Ptui live test\n[User] hi\n</chat-history-summary>\n\nWhat next?"
  expect(collapseForkContext(forked)).toBe("↳ forked from Ptui live test\n\nWhat next?")
  expect(collapseForkContext("no fork")).toBe("no fork")
})

test("drops a compaction's stale loading entry from history pages", () => {
  const entries = [
    { item: { type: "user_message", text: "/compact" } },
    { item: { type: "compaction", status: "loading" } },
    { item: { type: "compaction", status: "completed" } },
  ] satisfies { item: AgentTimelineItem }[]
  expect(dropStaleCompactions(entries).map((entry) => entry.item.type === "compaction" && entry.item.status)).toEqual([false, "completed"])
  expect(dropStaleCompactions([entries[1]!])).toHaveLength(1)
})

test("a tool's final unknown detail keeps the richer live detail", () => {
  const rows: AgentTimelineItem[] = []
  const task = { type: "tool_call", callId: "t", name: "Task", status: "running", error: null, detail: { type: "sub_agent", subAgentType: "general-purpose", description: "Reply", log: "", actions: [] } } satisfies AgentTimelineItem
  applyTimelineItem(rows, task)
  applyTimelineItem(rows, { ...task, name: "Agent", status: "completed", detail: { type: "unknown", input: {}, output: null } } satisfies AgentTimelineItem)
  expect(rows[0]).toMatchObject({ status: "completed", detail: { type: "sub_agent", description: "Reply" } })
})

test("Paseo's tool-image messages stay separate rows and resolve to a local file", () => {
  const rows: AgentTimelineItem[] = []
  applyTimelineItem(rows, { type: "assistant_message", text: "![Image](file:///var/folders/x/paseo-attachments-1/a%20b.png)" })
  applyTimelineItem(rows, { type: "assistant_message", text: "Red", messageId: "msg_1" })
  expect(rows.map((row) => row.type === "assistant_message" && row.text)).toEqual(["![Image](file:///var/folders/x/paseo-attachments-1/a%20b.png)", "Red"])
  expect(imageFile((rows[0] as { text: string }).text)).toBe("/var/folders/x/paseo-attachments-1/a b.png")
  expect(imageFile("see ![Image](file:///x.png)")).toBeUndefined()
})
