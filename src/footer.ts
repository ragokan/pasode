// Prompt-footer text, ported from OpenCode 2.0.26 feature-plugins/prompt/footer.tsx + util/{session,locale}.ts (MIT).

/** Locale.number: 236912 → "236.9K". */
export function formatTokens(value: number) {
  // 999_950 would round to "1000.0K".
  if (value >= 999_950) return (value / 1_000_000).toFixed(1) + "M"
  if (value >= 1000) return (value / 1000).toFixed(1) + "K"
  return String(value)
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** ["236.9K (24%)", "$0.11"] from Paseo's lastUsage (cost only when non-zero, like OpenCode). */
export function usageItems(usage?: { contextWindowUsedTokens?: number | null; contextWindowMaxTokens?: number | null; totalCostUsd?: number | null } | null) {
  const tokens = usage?.contextWindowUsedTokens
  const items: string[] = []
  if (tokens && tokens > 0) {
    const max = usage?.contextWindowMaxTokens
    items.push(max ? `${formatTokens(tokens)} (${Math.round((tokens / max) * 100)}%)` : formatTokens(tokens))
  }
  if (usage?.totalCostUsd && usage.totalCostUsd > 0) items.push(money.format(usage.totalCostUsd))
  return items
}

/** "2 subagents · 1 shell" (only the parts that are non-zero). */
export function liveLabel(subagents: number, shells: number) {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
  return [subagents && plural(subagents, "subagent"), shells && plural(shells, "shell")].filter(Boolean).join(" · ") || undefined
}

/** promptFooterLayout: what fits beside the location (usage first, then the shortcut). */
export function footerLayout(width: number, usage: string[], shortcuts: string[]) {
  const used = usage.join(" · ")
  const keys = shortcuts.join(" · ")
  const available = Math.max(0, width - Math.min(28, Math.floor(width / 2)))
  if (used && keys && Bun.stringWidth(`${used} · ${keys}`) <= available) return { usage: true, shortcuts: true }
  if (used && Bun.stringWidth(used) <= available) return { usage: true, shortcuts: false }
  if (!used && keys && Bun.stringWidth(keys) <= available) return { usage: false, shortcuts: true }
  return { usage: false, shortcuts: false }
}
