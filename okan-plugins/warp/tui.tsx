// Provenance: ~/coding/ocode/plugins/warp/src/{tui,v2,notify,title}.ts (Warp MIT).
// .tsx makes OpenTUI's Solid transform bind these hooks to the host runtime too.
import { writeFileSync } from "node:fs"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { PasodePlugin } from "@pasode/host"
import { formatTitle, inKaku, inWarp, PLUGIN_VERSION, richSequence, SPINNER, SPINNER_MS, truncate } from "./payload"
import { createTransitions, type AgentState } from "./transitions"

const HANDSHAKE_DELAY_MS = 1000
/** A turn that ends without an attention flag (e.g. interrupted) still has to clear Warp's busy badge. */
const SETTLE_MS = 3000

export default {
  id: "warp",
  setup(ctx) {
    const kaku = inKaku(process.env)
    // Kaku shows app titles verbatim, so a running session gets ocode's spinner there; elsewhere a static "•".
    const [frame, setFrame] = createSignal(0)
    createEffect(() => {
      if (!kaku || ctx.paseo.current()?.status !== "running") return
      const timer = setInterval(() => setFrame((n) => n + 1), SPINNER_MS)
      onCleanup(() => clearInterval(timer))
    })
    let lastTitle: string | undefined
    // The host acknowledges a finish on the session you look at, clearing its flag; keep ✓/🔴 until it runs again.
    const outcome = new Map<string, "finished" | "error">()
    createEffect(() => {
      const agent = ctx.paseo.current()
      const reason = agent?.attentionReason
      if (agent?.status === "running") outcome.delete(agent.id)
      else if (agent && (reason === "finished" || reason === "error")) outcome.set(agent.id, reason)
      const last = agent && outcome.get(agent.id)
      const indicator = agent?.pendingPermissions.length || agent?.requiresAttention && reason === "permission" ? "🟡 "
        : agent?.status === "running" ? (kaku ? SPINNER[frame() % SPINNER.length] + " " : "• ")
        : agent?.status === "error" || last === "error" ? "🔴 "
        : last === "finished" ? "✓ " : ""
      const title = formatTitle(agent && ctx.paseo.sessionTitle(agent), indicator)
      if (title !== lastTitle) ctx.renderer.setTerminalTitle(lastTitle = title)
    })

    if (ctx.options.notifications === false || !(inWarp(process.env) || kaku)) return
    if (kaku) {
      // Paseo notifies one present client per finish (its computeNotificationPlan). Report this one as present, with
      // its shown session and terminal focus, so the desktop app or a phone doesn't repeat Kaku's notification.
      let visible = true
      const beat = () => {
        try {
          ctx.paseo.daemon.sendHeartbeat({ deviceType: "web", focusedAgentId: ctx.paseo.agentId() ?? null, appVisible: visible, lastActivityAt: new Date().toISOString() })
        } catch {}
      }
      const focus = () => { visible = true; beat() }
      const blur = () => { visible = false; beat() }
      ctx.renderer.on("focus", focus)
      ctx.renderer.on("blur", blur)
      const events = ctx.paseo.daemon.observeEvents(["agent_attention_required"], { notifications: true })
      events.ready.catch(() => {})
      createEffect(beat) // and whenever the shown session changes
      const heartbeat = setInterval(beat, 30_000)
      onCleanup(() => {
        clearInterval(heartbeat)
        ctx.renderer.off("focus", focus)
        ctx.renderer.off("blur", blur)
        void events.release().catch(() => {})
      })
    }
    const write = (sequence: string | undefined) => {
      if (!sequence) return
      try { writeFileSync("/dev/tty", sequence) }
      catch { try { process.stdout.write(sequence) } catch {} }
    }

    // Warp tracks one agent per pane: rich events describe only the session on screen (like ocode's isShown).
    const started = new Set<string>()
    const busy = new Set<string>()
    const rich = (event: string, agent: Pick<AgentState, "id" | "cwd">, extra: Record<string, unknown> = {}) => {
      if (!started.has(agent.id)) {
        started.add(agent.id)
        write(richSequence("session_start", agent, { plugin_version: PLUGIN_VERSION }, process.env))
      }
      write(richSequence(event, agent, extra, process.env))
    }
    const lastText = (agentId: string, type: "user_message" | "assistant_message") => {
      // The open timeline may already belong to another session (e.g. after a delayed settle).
      if (ctx.paseo.timeline.agentId !== agentId) return ""
      const row = ctx.paseo.timeline.rows.findLast((item) => item.type === type)
      return row?.type === "user_message" || row?.type === "assistant_message" ? truncate(row.text.trim(), 200) : ""
    }
    const timer = setTimeout(() => {
      const agent = ctx.paseo.current()
      if (agent && !started.size) rich("idle_prompt", agent)
    }, HANDSHAKE_DELAY_MS)
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    onCleanup(() => {
      clearTimeout(timer)
      for (const pending of settleTimers.values()) clearTimeout(pending)
    })

    const transitions = createTransitions()
    createEffect(() => {
      const agents = Object.values(ctx.paseo.agents).map((agent) => ({
        id: agent.id, cwd: agent.cwd, title: ctx.paseo.sessionTitle(agent), status: agent.status,
        pendingPermissions: [...agent.pendingPermissions], requiresAttention: agent.requiresAttention,
        attentionReason: agent.attentionReason, attentionTimestamp: agent.attentionTimestamp,
      }))
      const shown = ctx.paseo.agentId()
      for (const change of transitions(agents)) {
        const { agent } = change
        const onScreen = agent.id === shown
        clearTimeout(settleTimers.get(agent.id))
        if (change.event === "prompt_submit") {
          busy.add(agent.id)
          if (onScreen) rich("prompt_submit", agent, { query: lastText(agent.id, "user_message") })
        } else if (change.event === "permission_request") {
          const pending = agent.pendingPermissions[0]
          if (onScreen) rich("permission_request", agent, { summary: formatTitle(agent.title), tool_name: pending?.name ?? "permission", tool_input: pending?.input ?? {} })
          if (onScreen && kaku) ctx.renderer.triggerNotification("Needs your input", formatTitle(agent.title, "🟡 "))
        } else if (change.event === "permission_replied") {
          if (onScreen) rich("permission_replied", agent)
        } else if (change.event === "stop") {
          busy.delete(agent.id)
          if (onScreen) rich("stop", agent, { query: lastText(agent.id, "user_message"), response: lastText(agent.id, "assistant_message"), transcript_path: "" })
          // Kaku, like ocode there: one notification per event, only for the session on screen.
          if (onScreen && kaku) {
            const title = formatTitle(agent.title, change.outcome === "error" ? "🔴 " : "✓ ")
            ctx.renderer.triggerNotification(lastText(agent.id, "assistant_message").replace(/\s+/g, " ") || "Session done", title)
          }
        } else if (change.event === "settled" && onScreen && busy.has(agent.id)) {
          settleTimers.set(agent.id, setTimeout(() => {
            const now = ctx.paseo.agents[agent.id]
            if (!busy.has(agent.id) || now?.status === "running") return
            busy.delete(agent.id)
            rich("stop", agent, { query: lastText(agent.id, "user_message"), response: lastText(agent.id, "assistant_message"), transcript_path: "" })
          }, SETTLE_MS))
        }
      }
    })
  },
} satisfies PasodePlugin
