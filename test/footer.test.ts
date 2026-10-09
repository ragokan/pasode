import { expect, test } from "bun:test"
import { footerLayout, formatTokens, liveLabel, usageItems } from "../src/footer"

test("context usage reads like OpenCode's footer", () => {
  expect(formatTokens(236_912)).toBe("236.9K")
  expect(formatTokens(1_250_000)).toBe("1.3M")
  expect(formatTokens(999)).toBe("999")
  expect(usageItems({ contextWindowUsedTokens: 236_912, contextWindowMaxTokens: 1_000_000, totalCostUsd: 0 })).toEqual(["236.9K (24%)"])
  expect(usageItems({ contextWindowUsedTokens: 24_743, contextWindowMaxTokens: 1_000_000, totalCostUsd: 0.11 })).toEqual(["24.7K (2%)", "$0.11"])
  expect(usageItems(undefined)).toEqual([])
})

test("live label pluralizes and drops zeros", () => {
  expect(liveLabel(0, 2)).toBe("2 shells")
  expect(liveLabel(1, 1)).toBe("1 subagent · 1 shell")
  expect(liveLabel(0, 0)).toBeUndefined()
})

test("footer layout keeps usage before shortcuts when space runs out", () => {
  expect(footerLayout(120, ["236.9K (24%)"], ["ctrl+p commands"])).toEqual({ usage: true, shortcuts: true })
  expect(footerLayout(40, ["236.9K (24%)"], ["ctrl+p commands"])).toEqual({ usage: true, shortcuts: false })
  expect(footerLayout(10, ["236.9K (24%)"], ["ctrl+p commands"])).toEqual({ usage: false, shortcuts: false })
})
