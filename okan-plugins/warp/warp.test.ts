// Provenance: ~/coding/ocode/plugins/warp/tests/{v2,payload,title,notify}.test.ts semantics; Paseo fixtures authored for pasode.
import { expect, test } from "bun:test"
import path from "node:path"
import { formatTitle, richSequence } from "./payload"
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

test("in Kaku: an animated spinner while running, one notification per event for the session on screen", () => {
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
      const dispose = createRoot((dispose) => (plugin.setup({
        options: {},
        renderer: {
          setTerminalTitle: (title) => titles.push(title), triggerNotification: (message, title) => notes.push([title, message]),
          on: (name, fn) => { listeners[name] = fn }, off: (name, fn) => { if (listeners[name] === fn) delete listeners[name] },
        },
        paseo: {
          current: () => agents().a, agentId: () => "a", sessionTitle: (agent) => agent.title,
          get agents() { return agents() }, get timeline() { return { agentId: "a", rows: [{ type: "assistant_message", text: "All done.\\n\\nSee diff" }] } },
          daemon: {
            sendHeartbeat: (beat) => beats.push(beat),
            observeEvents: (...args) => { observed.push(args); return { ready: Promise.resolve(), release: async () => { released = true } } },
          },
        },
      }), dispose))
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
      setAgents({ ...agents(), a: agent("a", "running") })
      const finished = { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "t1" }
      setAgents({ ...agents(), a: agent("a", "idle", finished) })
      setAgents({ ...agents(), b: agent("b", "idle", finished) })
      assert.deepEqual(notes, [["🟡 a", "Needs your input"], ["✓ a", "All done. See diff"]])
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
