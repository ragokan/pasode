// Provenance: ~/coding/ocode/plugins/usage-sidebar/usage.test.ts formatting cases; Paseo fixtures authored for pasode.
import { expect, test } from "bun:test"
import type { PaseoProviderUsageResult } from "@getpaseo/client"
import { formatReset, usageWindows, zeroSubAccounts, type ZeroSubState } from "./usage"

const now = Date.UTC(2026, 9, 9)
const provider = (windows: PaseoProviderUsageResult["providers"][number]["windows"]): PaseoProviderUsageResult["providers"][number] => ({
  providerId: "claude", displayName: "Claude", status: "available", planLabel: null, windows,
})

test("countdowns round down to 3d4h / 3h2m", () => {
  expect(formatReset((3 * 24 + 4) * 3_600_000 + 50_000)).toBe("3d4h")
  expect(formatReset((3 * 60 + 2) * 60_000 + 59_000)).toBe("3h2m")
  expect(formatReset(24 * 3_600_000)).toBe("1d0h")
  expect(formatReset(-5)).toBe("0h0m")
})

test("usage is percent used, invalid readings and Fable are omitted", () => {
  expect(usageWindows(provider([
    { id: "5h", label: "5h", usedPct: 12.4, resetsAt: new Date(now + (3 * 60 + 2) * 60_000).toISOString() },
    { id: "7d", label: "7d", remainingPct: 72, resetsAt: new Date(now + (3 * 24 + 4) * 3_600_000).toISOString() },
    { id: "fable", label: "7d Fable", usedPct: 85 },
    { id: "bad", label: "invalid", usedPct: NaN },
    { id: "none", label: "no reading", usedPct: null },
  ]), now)).toEqual([
    { countdown: "3h2m", percent: "12%" },
    { countdown: "3d4h", percent: "28%" },
  ])
  expect(usageWindows(undefined, now)).toEqual([])
  expect(usageWindows({ ...provider([]), status: "error" }, now)).toEqual([])
})

test("missing resets keep labels; expired readings are explicitly inferred", () => {
  expect(usageWindows(provider([
    { id: "a", label: "Weekly", shortLabel: "7d", usedPct: 120, resetsAt: "bad" },
    { id: "b", label: "5h", usedPct: 70, resetsAt: new Date(now - 1).toISOString() },
    { id: "c", label: "5h", usedPct: -10 },
  ]), now)).toEqual([
    { countdown: "7d", percent: "100%" },
    { countdown: "0h0m", percent: "~0%" },
    { countdown: "5h", percent: "0%" },
  ])
})

test("ZeroSub accounts reuse the window format and mark the account the session runs on", () => {
  const state: ZeroSubState = {
    accounts: [
      { id: "claude-main", family: "claude", label: "development", usage: { windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 22.4, resetsAt: new Date(now + (2 * 60 + 13) * 60_000).toISOString() },
        { id: "seven_day_fable", label: "Weekly · Fable", usedPercent: 0, resetsAt: null },
      ] } },
      { id: "claude-2", family: "claude", label: "okan", usage: null },
      { id: "codex-main", family: "codex", label: "okan", usage: { windows: [
        { id: "primary", label: "Weekly", usedPercent: 40, resetsAt: new Date(now + (3 * 24 + 22) * 3_600_000).toISOString() },
      ] } },
    ],
    agents: [{ agentId: "agent-1", accountId: "claude-main" }],
  }
  expect(zeroSubAccounts(state, "agent-1", now)).toEqual([
    { id: "claude-main", family: "claude", label: "development", current: true, windows: [{ countdown: "2h13m", percent: "22%" }] },
    { id: "claude-2", family: "claude", label: "okan", current: false, windows: [] },
    { id: "codex-main", family: "codex", label: "okan", current: false, windows: [{ countdown: "3d22h", percent: "40%" }] },
  ])
  expect(zeroSubAccounts(state, undefined, now).some((account) => account.current)).toBe(false)
})
