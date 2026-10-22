// Provenance: ~/coding/ocode/plugins/warp/tests/{v2,payload,title,notify}.test.ts semantics; Paseo fixtures authored for pasode.
import { expect, test } from "bun:test"
import path from "node:path"
import { ACK_MS as hostAck, PRESENT_MS as hostPresent, routeAttention as hostRoute } from "../../src/presence"
import { formatTitle, negotiateProtocolVersion, richSequence } from "./payload"
import { ACK_MS, PRESENT_MS, routeAttention } from "./routing"
import { createTransitions, type AgentState } from "./transitions"

const agent = (id: string, options: Partial<AgentState> = {}): AgentState => ({
  id, cwd: "/project", title: id, status: "idle", pendingPermissions: [], ...options,
})
const permission = { id: "request-1", provider: "claude" as const, name: "Edit", kind: "tool" as const, input: { file: "a.ts" } }
const events = (list: ReturnType<ReturnType<typeof createTransitions>>) => list.map((change) => change.event)

test("a new session's start-up flicker is not a finish; the attention flag is (recorded daemon sequence)", () => {
  const detect = createTransitions()
  // Seen live from Paseo 0.11.1 for `api.agents.create({ prompt })`, in order.
  expect(detect([agent("a", { status: "initializing" })])).toEqual([])
  expect(events(detect([agent("a", { status: "idle" })]))).toEqual([])
  expect(events(detect([agent("a", { status: "running" })]))).toEqual(["prompt_submit"])
  expect(events(detect([agent("a", { status: "idle" })]))).toEqual(["settled"])
  expect(events(detect([agent("a", { status: "running" })]))).toEqual(["prompt_submit"])
  expect(events(detect([agent("a", { status: "running" })]))).toEqual([])
  const done = agent("a", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t1" })
  expect(detect([done]).map((change) => [change.event, "outcome" in change && change.outcome])).toEqual([["stop", "finished"]])
  expect(detect([done])).toEqual([]) // the daemon repeats the same update
})

test("every agent is tracked; baseline flags and repeats emit nothing; errors report their outcome", () => {
  const detect = createTransitions()
  expect(detect([agent("old", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t0" }), agent("b")])).toEqual([])
  expect(events(detect([agent("old", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t0" }), agent("b", { status: "running" })])))
    .toEqual(["prompt_submit"])
  const failed = detect([agent("old"), agent("b", { status: "error", requiresAttention: true, attentionReason: "error", attentionTimestamp: "t2" })])
  expect(failed.map((change) => [change.agent.id, change.event, "outcome" in change && change.outcome])).toEqual([["b", "stop", "error"]])
})

test("permission requests and replies emit once each", () => {
  const detect = createTransitions()
  detect([agent("a", { status: "running" })])
  expect(events(detect([agent("a", { status: "running", pendingPermissions: [permission] })]))).toEqual(["permission_request"])
  expect(detect([agent("a", { status: "running", pendingPermissions: [permission] })])).toEqual([])
  expect(events(detect([agent("a", { status: "running" })]))).toEqual(["permission_replied"])
})

test("snapshots survive mutable store changes, removed agents reset their baseline", () => {
  const detect = createTransitions()
  const mutable = agent("a", { status: "running" })
  detect([mutable])
  mutable.status = "idle"
  expect(events(detect([mutable]))).toEqual(["settled"])
  detect([])
  expect(detect([mutable])).toEqual([])
})

test("rich events speak as opencode inside Warp only", () => {
  const warp = { TERM_PROGRAM: "WarpTerminal", WARP_CLI_AGENT_PROTOCOL_VERSION: "1" }
  const sequence = richSequence("stop", { id: "a", cwd: "/x/project" }, { summary: "done\x07" }, warp)!
  expect(sequence.startsWith("\x1b]777;notify;warp://cli-agent;")).toBe(true)
  // JSON escapes controls (\u0007 as text), so the only raw BEL is the terminator.
  expect(sequence.slice(0, -1).includes("\x07")).toBe(false)
  expect(JSON.parse(sequence.slice("\x1b]777;notify;warp://cli-agent;".length, -1))).toEqual({ v: 1, agent: "opencode", event: "stop", session_id: "a", cwd: "/x/project", project: "project", summary: "done\x07" })
  expect(richSequence("stop", { id: "a", cwd: "" }, {}, { TERM_PROGRAM: "WarpTerminal" })).toBeUndefined()
  expect(richSequence("stop", { id: "a", cwd: "" }, {}, { TERM_PROGRAM: "Apple_Terminal", WARP_CLI_AGENT_PROTOCOL_VERSION: "1" })).toBeUndefined()
})

// ocode's negotiateProtocolVersion semantics: speak the older of Warp's protocol version and ours (1).
test.each([[undefined, 1], ["1", 1], ["99", 1], ["0", 0], ["not-a-number", 1]] as const)("Warp advertising protocol %p → payload v%p", (advertised, spoken) => {
  expect(negotiateProtocolVersion({ WARP_CLI_AGENT_PROTOCOL_VERSION: advertised })).toBe(spoken)
  if (!advertised) return // richSequence stays silent without a version
  const sequence = richSequence("stop", { id: "a", cwd: "/p" }, {}, { TERM_PROGRAM: "WarpTerminal", WARP_CLI_AGENT_PROTOCOL_VERSION: advertised })!
  expect(JSON.parse(sequence.slice("\x1b]777;notify;warp://cli-agent;".length, -1)).v).toBe(spoken)
})

test("a delayed stop never carries another session's transcript; off-screen sessions stay silent; titles follow sessionTitle", () => {
  const host = path.resolve(import.meta.dir, "../..")
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `
      // Capture terminal writes before any ESM import of node:fs snapshots writeFileSync.
      const fs = require("node:fs")
      const writeFileSync = fs.writeFileSync
      const writes = []
      fs.writeFileSync = (file, data, ...rest) => file === "/dev/tty" ? writes.push(data) : writeFileSync(file, data, ...rest)
      const assert = (await import("node:assert/strict")).default
      await import(Bun.resolveSync("@opentui/solid/preload", process.cwd()))
      const { ensureRuntimePluginSupport } = await import(Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", process.cwd()))
      ensureRuntimePluginSupport()
      const timers = []
      globalThis.setTimeout = (fn, ms) => timers.push({ fn, ms })
      globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {} }
      const { default: plugin } = await import(${JSON.stringify(path.join(import.meta.dir, "tui.tsx"))})
      const { createRoot, createSignal } = await import("opentui:runtime-module:solid-js")
      const agent = (id, status) => ({ id, cwd: "/p", title: id, status, pendingPermissions: [] })
      const rows = (q, a) => [{ type: "user_message", text: q }, { type: "assistant_message", text: a }]
      const [agents, setAgents] = createSignal({ a: agent("a", "idle"), b: agent("b", "idle") })
      const [shown, setShown] = createSignal("a")
      const [timeline, setTimeline] = createSignal({ agentId: "a", rows: rows("A question", "A answer") })
      const [workspaceTitle, setWorkspaceTitle] = createSignal()
      const titles = []
      createRoot(() => plugin.setup({
        options: {},
        renderer: { setTerminalTitle: (title) => titles.push(title) },
        paseo: {
          current: () => agents()[shown()], agentId: shown, sessionTitle: (agent) => workspaceTitle() ?? agent.title,
          get agents() { return agents() }, get timeline() { return timeline() },
        },
      }))
      setAgents({ ...agents(), a: agent("a", "running") })
      setAgents({ ...agents(), a: agent("a", "idle") })
      setShown("b")
      setTimeline({ agentId: "b", rows: rows("B question", "B answer") })
      timers.find((timer) => timer.ms === 3000).fn()
      const stop = JSON.parse(writes.at(-1).slice("\\x1b]777;notify;warp://cli-agent;".length, -1))
      assert.deepEqual([stop.event, stop.session_id, stop.query, stop.response], ["stop", "a", "", ""])
      const written = writes.length
      setAgents({ ...agents(), a: { ...agent("a", "idle"), requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t1" } })
      setAgents({ ...agents(), a: { ...agent("a", "idle"), pendingPermissions: [{ name: "Edit", input: {} }] } })
      assert.equal(writes.length, written)
      // Paseo's post-first-message rename reaches the terminal title.
      setWorkspaceTitle("Generated title")
      assert.equal(titles.at(-1), "Generated title")
      setWorkspaceTitle("x".repeat(40))
      assert.equal(titles.at(-1), "x".repeat(26) + "…")
    `],
    cwd: host,
    env: { ...process.env, TERM_PROGRAM: "WarpTerminal", WARP_CLI_AGENT_PROTOCOL_VERSION: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
}, 15_000)

test("in Kaku: an animated spinner while running, a notification for each attention event the daemon routes here", () => {
  const host = path.resolve(import.meta.dir, "../..")
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `
      const assert = (await import("node:assert/strict")).default
      await import(Bun.resolveSync("@opentui/solid/preload", process.cwd()))
      const { ensureRuntimePluginSupport } = await import(Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", process.cwd()))
      ensureRuntimePluginSupport()
      const intervals = []
      globalThis.setInterval = (fn, ms) => intervals.push({ fn, ms, live: true })
      globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].live = false }
      const { default: plugin } = await import(${JSON.stringify(path.join(import.meta.dir, "tui.tsx"))})
      const { createRoot, createSignal } = await import("opentui:runtime-module:solid-js")
      const agent = (id, status, extra = {}) => ({ id, cwd: "/p", title: id, status, pendingPermissions: [], ...extra })
      const [agents, setAgents] = createSignal({ a: agent("a", "running"), b: agent("b", "running") })
      const titles = []
      const notes = []
      const beats = []
      const listeners = {}
      const observed = []
      let released = false
      let attend
      const dispose = createRoot((dispose) => (plugin.setup({
        options: {},
        renderer: {
          setTerminalTitle: (title) => titles.push(title), triggerNotification: (message, title) => notes.push([title, message]),
          on: (name, fn) => { listeners[name] = fn }, off: (name, fn) => { if (listeners[name] === fn) delete listeners[name] },
          keyInput: { on() {}, off() {} },
        },
        state: { prefs: { notifications: true } },
        ui: { toast: () => { throw new Error("a blurred terminal gets a desktop notification, not a toast") } },
        paseo: {
          current: () => agents().a, agentId: () => "a", sessionTitle: (agent) => agent.title,
          get agents() { return agents() }, get timeline() { return { agentId: "a", rows: [{ type: "assistant_message", text: "All done.\\n\\nSee diff" }] } },
          daemon: {
            sendHeartbeat: (beat) => beats.push(beat),
            observeEvents: (...args) => { observed.push(args); return { ready: Promise.resolve(), release: async () => { released = true } } },
            onAgentAttentionRequired: (fn) => { attend = fn; return () => { attend = undefined } },
          },
        },
      }), dispose))
      const attention = (agentId, reason, shouldNotify = true) => attend({ agentId, reason, shouldNotify, timestamp: "t", notification: { title: "", body: "the daemon's preview", data: {} } })
      // Paseo picks one present client to notify; this one reports its session and focus.
      assert.deepEqual(observed, [[["agent_attention_required"], { notifications: true }]])
      assert.deepEqual([beats[0].deviceType, beats[0].focusedAgentId, beats[0].appVisible], ["web", "a", true])
      listeners.blur()
      assert.equal(beats.at(-1).appVisible, false)
      assert.equal(titles.at(-1), "⠲ a")
      const spinner = intervals.filter((timer) => timer.live && timer.ms === 250)
      assert.equal(spinner.length, 1)
      spinner[0].fn()
      assert.equal(titles.at(-1), "⠰ a")
      setAgents({ ...agents(), a: agent("a", "running", { pendingPermissions: [{ name: "Edit", input: {} }] }) })
      assert.deepEqual(notes, []) // the store changing is not an alert; the daemon's routed event is
      attention("a", "permission")
      setAgents({ ...agents(), a: agent("a", "running") })
      const finished = { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t1" }
      setAgents({ ...agents(), a: agent("a", "idle", finished) })
      setAgents({ ...agents(), b: agent("b", "idle", finished) })
      attention("a", "finished")
      attention("b", "finished", false) // counted, but the daemon picked another client
      assert.deepEqual(notes, [["🟡 a", "Needs your input"], ["✓ a", "All done. See diff"]])
      attention("b", "error") // picked for a session that isn't open: the daemon's preview stands in for the transcript
      assert.deepEqual(notes.at(-1), ["🔴 b", "the daemon's preview"])
      notes.pop()
      assert.equal(titles.at(-1), "✓ a")
      // The host acknowledges the finish on screen; the ✓ stays until the session runs again.
      setAgents({ ...agents(), a: agent("a", "idle") })
      assert.equal(titles.at(-1), "✓ a")
      assert.deepEqual(intervals.filter((timer) => timer.live).map((timer) => timer.ms), [30000])
      setAgents({ ...agents(), a: agent("a", "running") })
      assert.equal(titles.at(-1)[1], " ")
      assert.notEqual(titles.at(-1), "✓ a")
      dispose()
      assert.equal(released, true)
      assert.equal(attend, undefined)
      assert.deepEqual(Object.keys(listeners), [])
      assert.equal(intervals.filter((timer) => timer.live).length, 0)
    `],
    cwd: host,
    env: { ...process.env, TERM_PROGRAM: "Kaku", WARP_CLI_AGENT_PROTOCOL_VERSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
}, 15_000)

test("in Kaku: heartbeats report real input and focus as activity, never the beat itself, so an idle or blurred terminal stops looking present", () => {
  const host = path.resolve(import.meta.dir, "../..")
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `
      const assert = (await import("node:assert/strict")).default
      await import(Bun.resolveSync("@opentui/solid/preload", process.cwd()))
      const { ensureRuntimePluginSupport } = await import(Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", process.cwd()))
      ensureRuntimePluginSupport()
      const intervals = []
      globalThis.setInterval = (fn, ms) => intervals.push({ fn, ms, live: true })
      globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].live = false }
      let now = Date.parse("2026-01-01T00:00:00Z")
      Date.now = () => now
      const { default: plugin } = await import(${JSON.stringify(path.join(import.meta.dir, "tui.tsx"))})
      const { createRoot, createSignal } = await import("opentui:runtime-module:solid-js")
      const [shown, setShown] = createSignal("a")
      const beats = []
      const listeners = {}
      const keys = new Set()
      const iso = (at) => new Date(at).toISOString()
      const launched = now
      const dispose = createRoot((dispose) => (plugin.setup({
        options: {},
        renderer: {
          setTerminalTitle: () => {}, triggerNotification: () => {},
          on: (name, fn) => { listeners[name] = fn }, off: (name, fn) => { if (listeners[name] === fn) delete listeners[name] },
          keyInput: { on: (name, fn) => { assert.equal(name, "keypress"); keys.add(fn) }, off: (name, fn) => keys.delete(fn) },
        },
        paseo: {
          current: () => undefined, agentId: shown, sessionTitle: () => "",
          agents: {}, timeline: { agentId: "a", rows: [] },
          daemon: { sendHeartbeat: (beat) => beats.push(beat), observeEvents: () => ({ ready: Promise.resolve(), release: async () => {} }), onAgentAttentionRequired: () => () => {} },
        },
      }), dispose))
      const beat = () => intervals.find((timer) => timer.live && timer.ms === 30000).fn()
      assert.equal(beats.at(-1).lastActivityAt, iso(launched))

      now += 181_000 // idle: the periodic beat repeats the time of the last real input
      beat()
      assert.equal(beats.at(-1).lastActivityAt, iso(launched))
      listeners.blur() // leaving isn't activity either
      assert.deepEqual([beats.at(-1).appVisible, beats.at(-1).lastActivityAt], [false, iso(launched)])
      now += 60_000
      beat()
      assert.equal(beats.at(-1).lastActivityAt, iso(launched))

      now += 1_000 // a key press is
      for (const fn of keys) fn({ name: "a" })
      beat()
      assert.equal(beats.at(-1).lastActivityAt, iso(now))
      now += 1_000 // coming back is
      listeners.focus()
      assert.deepEqual([beats.at(-1).appVisible, beats.at(-1).lastActivityAt], [true, iso(now)])
      now += 1_000 // so is opening another session
      setShown("b")
      assert.deepEqual([beats.at(-1).focusedAgentId, beats.at(-1).lastActivityAt], ["b", iso(now)])

      dispose()
      assert.equal(keys.size, 0)
    `],
    cwd: host,
    env: { ...process.env, TERM_PROGRAM: "Kaku", WARP_CLI_AGENT_PROTOCOL_VERSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
}, 15_000)

test("in Kaku: alerts follow the host's policy: picked alerts, counted-but-not-picked stays quiet, idle falls back to unacknowledged sessions opened here", () => {
  const host = path.resolve(import.meta.dir, "../..")
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", `
      const assert = (await import("node:assert/strict")).default
      await import(Bun.resolveSync("@opentui/solid/preload", process.cwd()))
      const { ensureRuntimePluginSupport } = await import(Bun.resolveSync("@opentui/solid/runtime-plugin-support/configure", process.cwd()))
      ensureRuntimePluginSupport()
      globalThis.setInterval = () => 0
      globalThis.clearInterval = () => {}
      const waiting = []
      const cleared = []
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      let ids = 0
      globalThis.setTimeout = (fn, ms, ...rest) => ms === 3000 ? (fn.id = ++ids, waiting.push(fn), fn.id) : realSetTimeout(fn, ms, ...rest)
      globalThis.clearTimeout = (id) => typeof id === "number" ? cleared.push(id) : realClearTimeout(id)
      let now = Date.parse("2026-01-01T00:00:00Z")
      Date.now = () => now
      const { default: plugin } = await import(${JSON.stringify(path.join(import.meta.dir, "tui.tsx"))})
      const { createRoot, createSignal } = await import("opentui:runtime-module:solid-js")
      const agent = (id) => ({ id, cwd: "/p", title: id, status: "idle", pendingPermissions: [], requiresAttention: false })
      const agents = { a: agent("a"), z: agent("z") }
      const [shown, setShown] = createSignal("a")
      const prefs = { notifications: true }
      const notes = []
      const toasts = []
      const listeners = {}
      const keys = new Set()
      let attend
      const dispose = createRoot((dispose) => (plugin.setup({
        options: {},
        renderer: {
          setTerminalTitle: () => {}, triggerNotification: (message, title) => notes.push([title, message]),
          on: (name, fn) => { listeners[name] = fn }, off: () => {},
          keyInput: { on: (name, fn) => keys.add(fn), off: (name, fn) => keys.delete(fn) },
        },
        state: { prefs },
        ui: { toast: (message, variant, title) => toasts.push([title, message, variant]) },
        paseo: {
          current: () => agents[shown()], agentId: shown, sessionTitle: (agent) => agent.title,
          agents, timeline: { agentId: "a", rows: [{ type: "assistant_message", text: "All done." }] },
          daemon: {
            sendHeartbeat: () => {}, observeEvents: () => ({ ready: Promise.resolve(), release: async () => {} }),
            onAgentAttentionRequired: (fn) => { attend = fn; return () => { attend = undefined } },
          },
        },
      }), dispose))
      const attention = (agentId, reason, shouldNotify) => attend({ agentId, reason, shouldNotify, timestamp: "t", notification: { title: "", body: "preview", data: {} } })
      const idle = () => { now += 151_000 }

      // Counted (just launched). Picked: alert, as a toast in front and a desktop notification in the background.
      attention("a", "finished", true)
      assert.deepEqual([notes, toasts], [[], [["✓ a", "All done.", "success"]]])
      listeners.blur()
      attention("a", "finished", true)
      attention("z", "permission", true) // any session: the daemon picked this client, so nobody else will say it
      assert.deepEqual(notes, [["✓ a", "All done."], ["🟡 z", "Needs your input"]])
      notes.length = 0
      // Counted but not picked: another client has it, or someone is watching.
      attention("a", "finished", false)
      assert.deepEqual([notes, waiting.length], [[], 0])
      // The pref silences picked alerts too.
      prefs.notifications = false
      attention("a", "finished", true)
      assert.deepEqual(notes, [])
      prefs.notifications = true

      // Idle past the window the daemon never counted this client: sessions opened here that nobody acknowledges alert.
      idle()
      attention("z", "finished", false) // never opened here
      assert.equal(waiting.length, 0)
      attention("a", "finished", false)
      assert.deepEqual([notes, waiting.length], [[], 1]) // not at once: a client viewing it acknowledges first
      agents.a.requiresAttention = false
      waiting.pop()()
      assert.deepEqual(notes, []) // acknowledged elsewhere
      agents.a.requiresAttention = true
      attention("a", "finished", false)
      waiting.pop()()
      assert.deepEqual(notes, [["✓ a", "All done."]]) // nobody did
      notes.length = 0
      attention("a", "finished", false)
      prefs.notifications = false // turned off during the wait
      waiting.pop()()
      assert.deepEqual(notes, [])
      prefs.notifications = true
      attention("a", "finished", false)
      listeners.focus() // looking at it by then
      waiting.pop()()
      assert.deepEqual([notes, toasts.length], [[], 1])
      listeners.blur()
      // The daemon sends each event twice to a client with the session open (one copy never routed, shouldNotify false):
      // one wait for the pair, and one alert.
      idle() // coming back to the window counted as activity
      attention("a", "finished", false)
      attention("a", "finished", false)
      assert.equal(waiting.length, 1)
      waiting.pop()()
      assert.deepEqual(notes, [["✓ a", "All done."]])
      notes.length = 0

      for (const fn of keys) fn({ name: "a" }) // typing counts the client again, and the daemon's answer is final
      attention("a", "finished", false)
      assert.equal(waiting.length, 0)

      idle()
      attention("a", "finished", false)
      assert.equal(waiting.length, 1)
      const pending = waiting.at(-1).id
      dispose() // a pending alert must not outlive the plugin
      assert.equal(attend, undefined)
      assert.equal(cleared.includes(pending), true)
    `],
    cwd: host,
    env: { ...process.env, TERM_PROGRAM: "Kaku", WARP_CLI_AGENT_PROTOCOL_VERSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
}, 15_000)

test("the plugin's alert policy is the host's: same window, same wait, same routing (a plugin can't import the host at runtime)", () => {
  expect([ACK_MS, PRESENT_MS]).toEqual([hostAck, hostPresent])
  for (const shouldNotify of [true, false]) for (const present of [true, false]) for (const watched of [true, false]) {
    expect(routeAttention({ shouldNotify, present, watched })).toBe(hostRoute({ shouldNotify, present, watched }))
  }
})

test("titles remove controls and keep ocode's label limits: 40, or 27 in Warp", () => {
  expect(formatTitle("hello\x1b\x07\x9cworld", "• ")).toBe("• hello   world")
  expect(formatTitle("x".repeat(40), "🟡 ")).toBe("🟡 " + "x".repeat(40))
  expect(formatTitle("x".repeat(41), "🟡 ")).toBe("🟡 " + "x".repeat(39) + "…")
  expect(formatTitle("x".repeat(28), "", 27)).toBe("x".repeat(26) + "…")
  // An emoji at the cut stays whole instead of leaving half a surrogate pair.
  expect(formatTitle("x".repeat(36) + "😀".repeat(5), "")).toBe("x".repeat(36) + "😀".repeat(3) + "…")
  expect(formatTitle("x".repeat(38) + "👩‍💻👩‍💻y", "")).toBe("x".repeat(38) + "👩‍💻…")
  expect(formatTitle(null)).toBe("Paseo")
})
