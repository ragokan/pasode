// Provenance: formerly src/metrics.ts, adapted from opencode-sidebar-token-metrics; unchanged except the countdown now lives in okan-plugins/usage-sidebar.
export type Mark =
  | { kind: "item"; type: string; at: number; callId?: string; status?: string }
  | { kind: "turn_started"; at: number }
  | { kind: "turn_completed"; at: number; outputTokens?: number }

export interface Metrics {
  /** output tokens / (turn time - tool time), averaged over turns seen live */
  tps?: number
  /** first output after a user message, averaged over turns */
  ttft?: number
}

export function computeMetrics(marks: readonly Mark[]): Metrics {
  let ttftTotal = 0
  let ttftCount = 0
  let generated = 0
  let elapsed = 0
  let waiting: number | undefined
  let lastUser: number | undefined
  let turnStart: number | undefined
  const tools = new Map<string, { start: number; end?: number }>()

  for (const mark of marks) {
    if (mark.kind === "turn_started") {
      turnStart = mark.at
      tools.clear()
      continue
    }
    if (mark.kind === "turn_completed") {
      // A turn that began before we subscribed starts at its user message.
      const start = turnStart ?? lastUser
      if (start !== undefined && mark.outputTokens) {
        let toolTime = 0
        // shortcut: original logic double-counts overlapping tools; merge intervals when parallel-tool accuracy is needed.
        for (const tool of tools.values()) if (tool.end !== undefined) toolTime += tool.end - tool.start
        const duration = mark.at - start - toolTime
        if (duration > 0) {
          generated += mark.outputTokens
          elapsed += duration
        }
      }
      turnStart = undefined
      continue
    }
    if (mark.type === "user_message") {
      waiting = lastUser = mark.at
      continue
    }
    if (waiting !== undefined) {
      if (mark.at > waiting) {
        ttftTotal += mark.at - waiting
        ttftCount++
      }
      waiting = undefined
    }
    if (mark.type === "tool_call" && mark.callId) {
      const tool = tools.get(mark.callId)
      if (!tool) tools.set(mark.callId, { start: mark.at, end: mark.status === "running" ? undefined : mark.at })
      else if (mark.status !== "running") tool.end = mark.at
    }
  }

  return {
    tps: generated > 0 && elapsed > 0 ? generated / (elapsed / 1000) : undefined,
    ttft: ttftCount > 0 ? ttftTotal / ttftCount : undefined,
  }
}

/** Claude reports cache reads apart from input; Codex counts them inside input. */
export function cacheHit(provider: string, usage?: { inputTokens?: number; cachedInputTokens?: number } | null) {
  const cached = usage?.cachedInputTokens ?? 0
  const input = usage?.inputTokens ?? 0
  const total = provider === "codex" ? input : input + cached
  return total > 0 ? cached / total : undefined
}

export function formatDelay(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
