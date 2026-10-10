// Provenance: ~/coding/ocode/plugins/usage-sidebar/usage.ts countdown/percent formatting; Paseo supplies readings.
import type { PaseoProviderUsageResult } from "@getpaseo/client"

type ProviderUsage = PaseoProviderUsageResult["providers"][number]

export function formatReset(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes >= 1440
    ? `${Math.floor(minutes / 1440)}d${Math.floor(minutes / 60) % 24}h`
    : `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

export function usageWindows(provider: ProviderUsage | undefined, now = Date.now()) {
  if (provider?.status !== "available") return []
  return provider.windows.flatMap((window) => {
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
