// Provenance: OpenCode MIT sidebar/context.tsx; adapted to Paseo AgentUsage.
import type { AgentUsage } from "@getpaseo/protocol/agent-types"

export function contextUsage(provider: string, usage?: AgentUsage) {
  const tokens = usage?.contextWindowUsedTokens ?? (usage
    ? (usage.inputTokens ?? 0) + (provider === "codex" ? 0 : usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
    : undefined)
  const limit = usage?.contextWindowMaxTokens
  return {
    tokens,
    percent: tokens !== undefined && limit && limit > 0 ? Math.round(tokens / limit * 100) : undefined,
    cost: usage?.totalCostUsd,
  }
}
