// Provenance: ~/coding/ocode/plugins/usage-sidebar/usage.ts countdown/percent formatting; Paseo supplies readings.
import type { PaseoProviderUsageResult } from "@getpaseo/client"
import type { UsageReportEntry } from "@getpaseo/protocol/messages"

type ProviderUsage = PaseoProviderUsageResult["providers"][number]
/** What a window list is read from: a provider's usage, or a usage report's content. */
type Reading = Pick<ProviderUsage, "status" | "windows"> | UsageReportEntry["report"]
export type Window = { countdown: string; percent: string; stale?: boolean }

/** The part of ZeroSub's `zerosub.state` reply (Paseo plugin @kapybara/zerosub) this plugin reads. */
export type ZeroSubState = {
  accounts: { id: string; family: string; label: string; usage: { windows: { id: string; label: string; usedPercent: number; resetsAt: string | null }[] } | null }[]
  agents: { agentId: string; accountId: string }[]
}

export function formatReset(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes >= 1440
    ? `${Math.floor(minutes / 1440)}d${Math.floor(minutes / 60) % 24}h`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

export function usageWindows(reading: Reading | undefined, now = Date.now()) {
  return reading?.status === "available" ? formatWindows(reading.windows, now) : []
}

/** The latest poll's windows; while it fails, the daemon's last successful ones, marked stale. */
export function reportWindows(entry: UsageReportEntry | undefined, now = Date.now()): Window[] {
  if (!entry) return []
  const live = usageWindows(entry.report, now)
  if (live.length || entry.report.status === "available") return live
  return usageWindows(entry.lastSuccessful?.report, now).map((window) => ({ ...window, stale: true }))
}

/** One source's accounts (e.g. two Claude logins) in the same shape as ZeroSub's. */
export function reportAccounts(entries: UsageReportEntry[], now = Date.now()) {
  return entries.map((entry) => ({ id: entry.id, label: entry.account.label ?? entry.sourceLabel, current: false, windows: reportWindows(entry, now) }))
}

/** ZeroSub accounts with the same window format; `current` is the account the agent runs on. */
export function zeroSubAccounts(state: ZeroSubState, agentId: string | undefined, now = Date.now()) {
  const using = state.agents.find((route) => route.agentId === agentId)?.accountId
  return state.accounts.map((account) => ({
    id: account.id,
    family: account.family,
    label: account.label,
    current: account.id === using,
    windows: formatWindows((account.usage?.windows ?? []).map((window) => ({ ...window, usedPct: window.usedPercent })), now),
  }))
}

function formatWindows(windows: ProviderUsage["windows"], now: number): Window[] {
  return windows.flatMap((window) => {
    if (/\bfable\b/i.test(window.label)) return []
    const used = window.usedPct ?? (window.remainingPct == null ? undefined : 100 - window.remainingPct)
    if (used === undefined || !Number.isFinite(used)) return []
    const reset = Date.parse(window.resetsAt ?? "")
    const expired = Number.isFinite(reset) && reset <= now
    return [{
      countdown: Number.isFinite(reset) ? formatReset(reset - now) : window.shortLabel ?? window.label,
      percent: `${expired ? "~0" : Math.round(Math.max(0, Math.min(100, used)))}%`,
    }]
  })
}
