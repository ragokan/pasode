import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types"
import { expect, test } from "bun:test"
import { durationLabel, turnFooters } from "./turns"

const rows: AgentTimelineItem[] = [{ type: "user_message", text: "Hi" }, { type: "assistant_message", text: "Done" }]

test("footer duration and speed both start at the prompt (OpenCode counts step creation → streamed)", () => {
  expect(turnFooters(rows, [1000, 1200], [
    { kind: "turn_started", at: 1050 }, { kind: "item", type: "assistant_message", at: 1100 },
    { kind: "turn_completed", at: 3100, outputTokens: 11 },
  ], false).get(1)).toEqual({ index: 1, duration: 2100, tps: 11 / 2.1, interrupted: false, error: undefined })
})

test("historical turns omit speed; live turns omit the entire footer", () => {
  expect(turnFooters(rows, [1000, 3100], [], false).get(1)?.duration).toBe(2100)
  expect(turnFooters(rows, [1000, 3100], [], false).get(1)?.tps).toBeUndefined()
  expect(turnFooters(rows, [1000, 3100], [], true).size).toBe(0)
})

test("turn marks cannot leak into adjacent turns; empty and zero-stream turns have no speed", () => {
  const history = [...rows, ...rows]
  const result = turnFooters(history, [1000, 2000, 3000, 4000], [{ kind: "turn_completed", at: 4000, outputTokens: 20 }], false)
  expect(result.get(1)?.tps).toBeUndefined()
  expect(result.get(3)?.tps).toBeUndefined()
  expect(result.get(1)?.duration).toBe(1000)
  expect(turnFooters([{ type: "user_message", text: "Pending" }], [1000], [], false).size).toBe(0)
})

test("interrupted/error footer state distinguishes terminal errors from failed tool calls", () => {
  expect(turnFooters([...rows, { type: "error", message: "Step interrupted" }], [1000, 1200, 1400], [], false).get(2)?.interrupted).toBe(true)
  expect(turnFooters([...rows, { type: "error", message: "Network failure" }], [1000, 1200, 1400], [], false).get(2)?.error).toBe("Network failure")
})

test("canceled tools signal interruption only when terminal, not when followed by successful output", () => {
  const canceled: AgentTimelineItem = { type: "tool_call", name: "read", callId: "c", status: "canceled", error: null, detail: { type: "read", filePath: "a" } }
  expect(turnFooters([rows[0]!, canceled], [1000, 2000], [], false).get(1)?.interrupted).toBe(true)
  expect(turnFooters([rows[0]!, canceled, rows[1]!], [1000, 2000, 3000], [], false).get(2)?.interrupted).toBe(false)
})

test.each([[999, "999ms"], [2100, "2.1s"], [61000, "1m 1s"], [3660000, "1h 1m"], [90000000, "1d 1h"]] as const)("duration %d → %s", (ms, expected) => expect(durationLabel(ms)).toBe(expected))

test("speed excludes tool execution, like OpenCode's per-step provider time (parallel tools counted once)", () => {
  const turn: AgentTimelineItem[] = [{ type: "user_message", text: "Run sleep" }, { type: "tool_call", name: "Bash", callId: "a", status: "completed", error: null, detail: { type: "shell", command: "sleep 6" } }, { type: "assistant_message", text: "ok" }]
  const tool = (callId: string, status: string, at: number) => ({ kind: "item" as const, type: "tool_call", callId, status, at })
  const marks = [tool("a", "running", 1500), tool("b", "running", 2000), tool("b", "completed", 3000), tool("a", "completed", 7500), { kind: "item" as const, type: "assistant_message", at: 8290 }, { kind: "turn_completed" as const, at: 8300, outputTokens: 130 }]
  // 7300ms turn − 6000ms of tools (b runs inside a) = 1300ms of provider time.
  expect(turnFooters(turn, [1000, 1500, 8290], marks, false).get(2)?.tps).toBe(100)
})
