// Terminal conveniences from OpenCode (MIT): copy on select, desktop notifications (attention.ts), window title,
// suspend, and the view toggles. App calls installUx once; the pure parts are exported for tests.
import { RendererControlState, type CliRenderer, type Selection } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, onCleanup } from "solid-js"
import { registerCommands, type Command } from "./commands"
import { copyToClipboard, useClipboardRenderer } from "./copy"
import { truncate } from "./dialog"
import { agents, daemon, sessionTitle } from "./paseo"
import { cycleRecentModel } from "./models"
import { loadedPlugins } from "./plugin"
import { ACK_MS, createPresence, HEARTBEAT_MS, routeAttention } from "./presence"
import { agentId, current, notify, prefs, setPref, showError, type Prefs } from "./state"
import { applyTheme } from "./theme"
import { loadTheme } from "./themes"

type Attention = Parameters<Parameters<typeof daemon.onAgentAttentionRequired>[0]>[0]

// Titles and notifications reach the terminal as escape sequences, so session text must not carry control bytes.
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

/** What a finished mouse selection should copy; nothing for a bare click (OpenCode's Selection.copy). */
export function selectionText(selection: Pick<Selection, "getSelectedText" | "isStart" | "behavior"> | null) {
  if (!selection || (selection.isStart && selection.behavior === "cell")) return ""
  return selection.getSelectedText()
}

/** Copies the renderer's selection and says so; false when there is nothing selected. The selection stays highlighted. */
export function copySelection(renderer: Pick<CliRenderer, "getSelection">) {
  const text = selectionText(renderer.getSelection())
  if (!text) return false
  void copyToClipboard(text).then((copied) => (copied ? notify("Copied", "success") : notify("No clipboard to copy to (install wl-clipboard, xclip or xsel)", "warning")))
  return true
}

const glyph = { finished: "✓", error: "✕", permission: "△" } as const

/** The daemon's own attention text (the same Paseo's apps show: a preview of the last reply, or the permission asked) under the session title. */
export function attentionNotice(event: Pick<Attention, "reason" | "notification">, session?: string | null) {
  return {
    title: truncate(clean(`${glyph[event.reason]} ${session || "Untitled"}`), 80),
    message: truncate(clean(event.notification?.body ?? "Needs your attention"), 240),
  }
}

export const windowTitle = (session?: string | null) => (session ? truncate(clean(session), 40) : "pasode")

/** OpenCode's terminal.suspend: hand the terminal back, stop the process group, redraw when the shell continues it. */
export function suspend(renderer: Pick<CliRenderer, "suspend" | "resume">, onResume?: () => void, kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill) {
  renderer.suspend()
  process.once("SIGCONT", () => (renderer.resume(), onResume?.()))
  kill(0, "SIGTSTP")
}

function cyclePref<K extends keyof Prefs>(key: K, order: readonly Prefs[K][], label: string) {
  const next = order[(order.indexOf(prefs[key]) + 1) % order.length]!
  setPref(key, next)
  notify(`${label}: ${typeof next === "boolean" ? (next ? "on" : "off") : next}`)
}

function toggleColorMode() {
  cyclePref("themeMode", ["dark", "light"], "Color mode")
  void loadTheme(prefs.theme, prefs.themeMode).then(applyTheme, showError)
}

/** `terminalFocused` is App's focus tracking (it also acknowledges attention on focus). */
export function installUx(renderer: CliRenderer, terminalFocused: () => boolean) {
  useClipboardRenderer(renderer)

  // OpenTUI emits "selection" when a mouse selection ends.
  const onSelection = () => prefs.copyOnSelect && copySelection(renderer)
  renderer.on("selection", onSelection)
  onCleanup(() => renderer.off("selection", onSelection))

  // The warp plugin owns the title (with status marks) wherever it is loaded, and notifications and Kaku's heartbeats
  // inside Warp and Kaku: there we send neither, so the daemon never hears two presences from one connection.
  const warp = () => loadedPlugins.some((plugin) => plugin.id === "warp" && !plugin.error)
  const warpOwns = () => warp() && ["warpterminal", "warp", "kaku"].includes(process.env.TERM_PROGRAM?.toLowerCase() ?? "")

  // The title last written (undefined: not ours). Agent updates re-run this often, so unchanged titles aren't re-sent;
  // `resumed` forces one after a suspend, when the shell has set its own.
  let written: string | undefined
  const retitle = (resumed = false) => {
    if (renderer.isDestroyed || renderer.controlState === RendererControlState.EXPLICIT_SUSPENDED) return
    const agent = current()
    const title = prefs.terminalTitle && !warp() ? windowTitle(agent && sessionTitle(agent)) : undefined
    if (title !== undefined && (resumed || title !== written)) renderer.setTerminalTitle(title)
    else if (title === undefined && written !== undefined && !prefs.terminalTitle) renderer.setTerminalTitle("")
    written = title
  }
  createEffect(() => retitle())
  renderer.once("destroy", () => written !== undefined && renderer.setTerminalTitle(""))

  // Tell the daemon what the Paseo app would: whether this terminal is in front and which session is open, and when we
  // last saw real input. It routes each attention event to one client from that, and nobody is alerted for a session
  // a visible client is focused on. The daemon forgets a client when its connection closes; the last beat says "away".
  const presence = createPresence((beat) => {
    try {
      daemon.sendHeartbeat(beat)
    } catch {} // not connected; the next beat catches up
  })
  useKeyboard(() => presence.active()) // shortcut: keys and focus only, so reading by mouse alone counts as idle
  createEffect(() => {
    if (!warpOwns()) presence.setVisible(terminalFocused())
  })
  createEffect(() => {
    if (!warpOwns()) presence.setAgent(agentId() ?? null)
  })
  createEffect(() => {
    if (warpOwns()) return
    presence.beat()
    const timer = setInterval(presence.beat, HEARTBEAT_MS)
    onCleanup(() => clearInterval(timer))
  })
  renderer.once("destroy", () => warpOwns() || presence.setVisible(false))

  // A session finishing, failing or asking for permission, as the daemon routes it (shouldNotify): the background
  // gets a desktop notification, a terminal in front a toast. A client the daemon didn't count (idle) falls back to
  // sessions opened here that nobody acknowledged, since the Paseo apps clear the flag when you view the session.
  const watched = new Set<string>()
  createEffect(() => {
    const id = agentId()
    if (id) watched.add(id)
  })
  const show = (event: Parameters<typeof attentionNotice>[0] & { agentId: string }) => {
    const agent = agents[event.agentId]
    const { title, message } = attentionNotice(event, agent && sessionTitle(agent))
    if (terminalFocused()) notify(message, ({ finished: "success", error: "error", permission: "warning" } as const)[event.reason], title)
    else renderer.triggerNotification(message, title)
  }
  const waiting = new Set<ReturnType<typeof setTimeout>>() // fallback alerts still in their ACK_MS wait
  const events = daemon.observeEvents(["agent_attention_required"], { notifications: true })
  events.ready.catch(() => {})
  const off = daemon.onAgentAttentionRequired((event) => {
    if (!prefs.notifications || warpOwns()) return
    const route = routeAttention({ shouldNotify: event.shouldNotify, present: presence.present(), watched: watched.has(event.agentId) })
    if (route === "now") show(event)
    else if (route === "unacknowledged") {
      // Everything is rechecked when it fires: the pref, warp, focus and the flag can all change during the wait.
      const timer = setTimeout(() => {
        waiting.delete(timer)
        if (prefs.notifications && !warpOwns() && !terminalFocused() && agents[event.agentId]?.requiresAttention) show(event)
      }, ACK_MS)
      waiting.add(timer)
    }
  })
  onCleanup(() => {
    off()
    waiting.forEach(clearTimeout)
    void events.release().catch(() => {})
  })

  const commands: Command[] = [
    { id: "terminal.suspend", title: "Suspend terminal", category: "System", keybind: "ctrl+z", enabled: () => process.platform !== "win32", run: () => suspend(renderer, () => retitle(true)) },
    { id: "theme.switch_mode", title: "Toggle light/dark mode", category: "View", slash: "colormode", run: toggleColorMode },
    { id: "session.verbosity.cycle", title: "Cycle transcript verbosity", category: "View", slash: "verbosity", run: () => cyclePref("verbosity", ["low", "medium", "high"], "Verbosity") },
    { id: "session.toggle.exploration_grouping", title: "Toggle tool grouping", category: "View", slash: "grouping", run: () => cyclePref("grouping", ["auto", "none"], "Tool grouping") },
    { id: "session.toggle.scrollbar", title: "Toggle scrollbar", category: "View", slash: "scrollbar", run: () => cyclePref("scrollbar", [false, true], "Scrollbar") },
    { id: "app.toggle.diffwrap", title: "Toggle diff wrapping", category: "View", slash: "diffwrap", run: () => cyclePref("diffWrap", ["word", "none"], "Diff wrapping") },
    { id: "model.cycle_recent", title: "Cycle recent models", category: "Agent", keybind: "f2", run: cycleRecentModel },
  ]
  onCleanup(registerCommands(commands))
}
