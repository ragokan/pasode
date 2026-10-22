// Provenance: ~/coding/ocode/plugins/warp/src/v2.ts event semantics; Paseo store-transition detection authored for pasode.
import type { PaseoAgent } from "@getpaseo/client"

export type AgentState = Pick<PaseoAgent, "id" | "cwd" | "title" | "status" | "pendingPermissions" | "requiresAttention" | "attentionReason" | "attentionTimestamp">
export type Transition =
  | { event: "prompt_submit" | "permission_request" | "permission_replied" | "settled"; agent: AgentState }
  | { event: "stop"; agent: AgentState; outcome: "finished" | "error" }

/**
 * "stop" comes only from the daemon's attention flag (a new attentionTimestamp with reason finished/error):
 * status alone flickers running → idle → running while a new session starts, which must not read as finished.
 * "settled" (running → idle without attention yet) lets the caller clear Warp's busy state if no stop follows.
 * Initial snapshots are a baseline, not a burst of stale notifications.
 */
export function createTransitions() {
  const previous = new Map<string, { agent: AgentState; stopped?: string }>()
  return (agents: readonly AgentState[]) => {
    const events: Transition[] = []
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of previous.keys()) if (!ids.has(id)) previous.delete(id)
    for (const agent of agents) {
      const last = previous.get(agent.id)
      // A finished flag already present at baseline is not news.
      let stopped = last ? last.stopped : attentionKey(agent)
      if (last) {
        if (agent.status === "running" && last.agent.status !== "running") events.push({ event: "prompt_submit", agent })
        const waiting = agent.pendingPermissions.length > 0
        const wasWaiting = last.agent.pendingPermissions.length > 0
        if (waiting && !wasWaiting) events.push({ event: "permission_request", agent })
        if (!waiting && wasWaiting) events.push({ event: "permission_replied", agent })
        const key = attentionKey(agent)
        if (key && key !== stopped) {
          stopped = key
          events.push({ event: "stop", agent, outcome: agent.attentionReason === "error" ? "error" : "finished" })
        } else if (last.agent.status === "running" && agent.status !== "running") events.push({ event: "settled", agent })
      }
      // Copy mutable Solid store data; retaining a proxy would erase the previous state.
      previous.set(agent.id, { agent: { ...agent, pendingPermissions: [...agent.pendingPermissions] }, stopped })
    }
    return events
  }
}

function attentionKey(agent: AgentState) {
  if (!agent.requiresAttention || (agent.attentionReason !== "finished" && agent.attentionReason !== "error")) return undefined
  return `${agent.attentionReason}:${agent.attentionTimestamp ?? ""}`
}
