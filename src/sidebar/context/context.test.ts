// Provenance: OpenCode sidebar/context.tsx; Paseo token-accounting checks authored for pasode.
import { expect, test } from "bun:test"
import { contextUsage } from "./context"

test("explicit context occupancy wins, with no fabricated reading", () => {
  expect(contextUsage("claude", { contextWindowUsedTokens: 300, contextWindowMaxTokens: 1000, totalCostUsd: 0.12 }))
    .toEqual({ tokens: 300, percent: 30, cost: 0.12 })
  expect(contextUsage("claude")).toEqual({ tokens: undefined, percent: undefined, cost: undefined })
})

test("Claude adds cached input, Codex input already includes it", () => {
  const usage = { inputTokens: 100, cachedInputTokens: 90, outputTokens: 10, contextWindowMaxTokens: 1000 }
  expect(contextUsage("claude", usage).tokens).toBe(200)
  expect(contextUsage("codex", usage).tokens).toBe(110)
  expect(contextUsage("codex", { ...usage, contextWindowMaxTokens: 0 }).percent).toBeUndefined()
})
