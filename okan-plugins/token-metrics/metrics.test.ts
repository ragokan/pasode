// Provenance: ~/coding/pasode/src/metrics.test.ts; retained regression fixtures.
import { expect, test } from "bun:test"
import { cacheHit, computeMetrics, formatDelay, type Mark } from "./metrics"

test("ttft from history, speed only from live turns with tool time removed", () => {
  const marks: Mark[] = [
    { kind: "item", type: "user_message", at: 0 },
    { kind: "item", type: "assistant_message", at: 2000 },
    { kind: "turn_started", at: 10_000 },
    { kind: "item", type: "user_message", at: 10_000 },
    { kind: "item", type: "reasoning", at: 11_000 },
    { kind: "item", type: "tool_call", at: 12_000, callId: "a", status: "running" },
    { kind: "item", type: "tool_call", at: 16_000, callId: "a", status: "completed" },
    { kind: "item", type: "assistant_message", at: 18_000 },
    { kind: "turn_completed", at: 20_000, outputTokens: 600 },
  ]
  expect(computeMetrics(marks)).toEqual({ ttft: 1500, tps: 100 })
  expect(computeMetrics([])).toEqual({ ttft: undefined, tps: undefined })
  const late: Mark[] = [
    { kind: "item", type: "user_message", at: 0 },
    { kind: "item", type: "assistant_message", at: 1000 },
    { kind: "turn_completed", at: 2000, outputTokens: 50 },
  ]
  expect(computeMetrics(late)).toEqual({ ttft: 1000, tps: 25 })
})

test("cache hit per provider usage semantics", () => {
  expect(cacheHit("claude", { inputTokens: 10, cachedInputTokens: 90 })).toBe(0.9)
  expect(cacheHit("codex", { inputTokens: 100, cachedInputTokens: 90 })).toBe(0.9)
  expect(cacheHit("claude", null)).toBeUndefined()
})

test("formats delays", () => {
  expect(formatDelay(2840)).toBe("2.8s")
  expect(formatDelay(420.4)).toBe("420ms")
})

test("nonpositive token-generation duration is not a speed reading", () => {
  expect(computeMetrics([
    { kind: "turn_started", at: 1000 },
    { kind: "turn_completed", at: 1000, outputTokens: 30 },
  ]).tps).toBeUndefined()
})
