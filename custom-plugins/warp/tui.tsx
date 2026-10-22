// Provenance: ~/coding/ocode/plugins/warp/src/{tui,v2,notify,title}.ts (Warp MIT).
// .tsx makes OpenTUI's Solid transform bind these hooks to the host runtime too.
import { writeFileSync } from "node:fs"
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import type { PasodePlugin } from "@pasode/host"
import { formatTitle, inKaku, inWarp, PLUGIN_VERSION, richSequence, SPINNER, SPINNER_MS, truncate, WARP_TITLE_MAX } from "./payload"
import { ACK_MS, PRESENT_MS, routeAttention } from "./routing"
import { createTransitions, type AgentState } from "./transitions"

const HANDSHAKE_DELAY_MS = 1000
/** A turn that ends without an attention flag (e.g. interrupted) still has to clear Warp's busy badge. */
const SETTLE_MS = 3000
const GLYPH = { permission: "🟡 ", finished: "✓ ", error: "🔴 " } as const
const VARIANT = { permission: "warning", finished: "success", error: "error" } as const

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
      const title = formatTitle(agent && ctx.paseo.sessionTitle(agent), indicator, inWarp(process.env) ? WARP_TITLE_MAX : 40)
      if (title !== lastTitle) ctx.renderer.setTerminalTitle(lastTitle = title)
    })

    if (ctx.options.notifications === false || !(inWarp(process.env) || kaku)) return
    if (kaku) {
      // Paseo notifies one present client per finish (its computeNotificationPlan). Report this one like the host's
      // own presence (src/presence.ts): its shown session and terminal focus, and when it last had real input or
      // focus. A beat is never activity, or an idle or blurred terminal would keep claiming alerts nobody sees.
      let visible = true
      let activeAt = Date.now()
      const active = () => { activeAt = Date.now() }
      const beat = () => {
        try {
          ctx.paseo.daemon.sendHeartbeat({ deviceType: "web", focusedAgentId: ctx.paseo.agentId() ?? null, appVisible: visible, lastActivityAt: new Date(activeAt).toISOString() })
        } catch {}
      }
      const focus = () => { visible = true; active(); beat() }
      const blur = () => { visible = false; beat() }
      ctx.renderer.on("focus", focus)
      ctx.renderer.on("blur", blur)
      ctx.renderer.keyInput.on("keypress", active)
      const events = ctx.paseo.daemon.observeEvents(["agent_attention_required"], { notifications: true })
      events.ready.catch(() => {})
      createEffect(() => { active(); beat() }) // and whenever the shown session changes, which is activity too
      const heartbeat = setInterval(beat, 30_000)

      // Alerts follow the host's policy (./routing.ts): the daemon's attention event says whether it picked this client.
      const watched = new Set<string>()
      createEffect(() => {
        const id = ctx.paseo.agentId()
        if (id) watched.add(id)
      })
      const alert = (event: { agentId: string; reason: keyof typeof GLYPH; notification?: { body: string } }) => {
        const live = ctx.paseo.agents[event.agentId]
        const title = formatTitle(live && ctx.paseo.sessionTitle(live), GLYPH[event.reason])
        const message = event.reason === "permission" ? "Needs your input"
          : lastText(event.agentId, "assistant_message").replace(/\s+/g, " ") || event.notification?.body || "Session done"
        // Kaku shows nothing while its window is in front, so a routed alert there is a toast.
        if (visible) ctx.ui.toast(message, VARIANT[event.reason], title)
        else ctx.renderer.triggerNotification(message, title)
      }
      const waiting = new Map<string, ReturnType<typeof setTimeout>>()
      const unsubscribe = ctx.paseo.daemon.onAgentAttentionRequired((event) => {
        if (!ctx.state.prefs.notifications) return
        const route = routeAttention({ shouldNotify: event.shouldNotify, present: Date.now() - activeAt <= PRESENT_MS, watched: watched.has(event.agentId) })
        if (route === "now") alert(event)
        else if (route === "unacknowledged") {
          // A client with the session open gets each event twice (the provider's copy is never routed: shouldNotify false).
          const key = `${event.agentId}:${event.reason}`
          if (waiting.has(key)) return
          // Everything is rechecked when it fires: the pref, focus and the flag can all change during the wait.
          waiting.set(key, setTimeout(() => {
            waiting.delete(key)
            if (ctx.state.prefs.notifications && !visible && ctx.paseo.agents[event.agentId]?.requiresAttention) alert(event)
          }, ACK_MS))
        }
      })
      onCleanup(() => {
        unsubscribe()
        waiting.forEach((timer) => clearTimeout(timer))
        clearInterval(heartbeat)
        ctx.renderer.off("focus", focus)
        ctx.renderer.off("blur", blur)
        ctx.renderer.keyInput.off("keypress", active)
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
    // The workspace-title lookup behind sessionTitle ran for every agent on every update (and subscribed to all of them);
    // only the agents that change state need it.
    const titleOf = (agent: AgentState) => untrack(() => { const live = ctx.paseo.agents[agent.id]; return live ? ctx.paseo.sessionTitle(live) : agent.title })
    createEffect(() => {
      const agents = Object.values(ctx.paseo.agents).map((agent) => ({
        id: agent.id, cwd: agent.cwd, title: agent.title, status: agent.status,
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
          if (onScreen) rich("permission_request", agent, { summary: formatTitle(titleOf(agent)), tool_name: pending?.name ?? "permission", tool_input: pending?.input ?? {} })
        } else if (change.event === "permission_replied") {
          if (onScreen) rich("permission_replied", agent)
        } else if (change.event === "stop") {
          busy.delete(agent.id)
          if (onScreen) rich("stop", agent, { query: lastText(agent.id, "user_message"), response: lastText(agent.id, "assistant_message"), transcript_path: "" })
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
