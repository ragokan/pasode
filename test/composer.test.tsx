import { renderTerminalSnapshotToAnsi } from "@getpaseo/protocol/terminal-snapshot"
import { KeyEvent, StdinParser } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createRoot } from "solid-js"
import { Composer, composerOpen, handleComposerKey, registerTerminalCommands, runShell, runningSubagents, subagents, terminals, toggleComposer, useSubagentFeed, useTerminalFeed } from "../src/composer"
import { runCommand } from "../src/commands"
import { config } from "../src/config"
import { dialog, DialogHost } from "../src/dialog"
import { daemon, openSubagentTimeline, setAgents, setCatalog, timeline, type PaseoAgent } from "../src/paseo"
import { agentId, setAgentId } from "../src/state"
import { paneFocused } from "../src/terminal"

let screen: TestRendererSetup | undefined
let spies: { mockRestore(): void }[] = []
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
  for (const spy of spies.splice(0)) spy.mockRestore()
  dialog.clear()
})
const spy = <T extends { mockRestore(): void }>(value: T) => (spies.push(value), value)

const agent = (id: string, status: string, labels: Record<string, string> = {}) =>
  ({ id, title: `Session ${id}`, status, labels, cwd: "/tmp/x", provider: "claude", pendingPermissions: [], workspaceId: "w" }) as unknown as PaseoAgent
const key = (name: string, ctrl = false) => ({ name, ctrl, shift: false, meta: false }) as Parameters<typeof handleComposerKey>[0]
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** A daemon OwnedSubscription stand-in: tests push snapshots and updates through it. */
function fakeFeed() {
  const observers: { snapshot(value: unknown): void; update(message: unknown): void }[] = []
  const feed = {
    ready: Promise.resolve({}),
    subscriptionId: "s",
    released: 0,
    subscribe(observer: (typeof observers)[number]) {
      observers.push(observer)
      return () => {}
    },
    release: async () => void feed.released++,
  }
  return {
    feed: feed as never,
    state: feed,
    snapshot: (value: unknown) => observers.forEach((observer) => observer.snapshot(value)),
    update: (message: unknown) => observers.forEach((observer) => observer.update(message)),
  }
}

test("↓ composer lists running child sessions, switches tabs, toggles finished, and closes like OpenCode's", async () => {
  setAgents({
    parent: agent("parent", "idle"),
    a: agent("a", "running", { "paseo.parent-agent-id": "parent" }),
    b: { ...agent("b", "idle", { "paseo.parent-agent-id": "parent" }), model: "claude-sonnet-5-5", thinkingOptionId: "high" },
  })
  setCatalog("claude", [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5" }] as never)
  setAgentId("parent")
  expect(runningSubagents()).toBe(1)
  screen = await testRender(() => <Composer />, { width: 100, height: 14 })
  toggleComposer()
  await screen.renderOnce()
  let frame = screen.captureCharFrame()
  expect(frame).toContain("Subagents  Shell")
  expect(frame).toMatch(/Agent: Session a\s+Running/)
  expect(frame).not.toContain("Session b")
  expect(frame).toContain("enter open  ctrl+d interrupt  ctrl+a finished  ctrl+k archive  ctrl+u detach")

  handleComposerKey(key("a", true))
  await screen.renderOnce()
  frame = screen.captureCharFrame()
  expect(frame).toMatch(/Agent: Session b\s+Sonnet 5\.5 · high\s/)
  expect(frame).not.toContain("Session a ")
  setCatalog("claude", [])

  handleComposerKey(key("right"))
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("No shells in this directory")

  expect(handleComposerKey(key("escape"))).toBe(true)
  expect(composerOpen()).toBe(false)
  expect(handleComposerKey(key("escape"))).toBe(false)
})

test("the terminal list follows the daemon's pushes, resubscribes on a directory change and releases on cleanup", async () => {
  setAgents({ a: agent("a", "idle"), b: { ...agent("b", "idle"), cwd: "/tmp/y" } })
  setAgentId("a")
  const first = fakeFeed()
  const second = fakeFeed()
  const observe = spy(spyOn(daemon, "observeTerminals")).mockReturnValueOnce(first.feed).mockReturnValueOnce(second.feed)
  const interval = spy(spyOn(globalThis, "setInterval"))
  const dispose = createRoot((dispose) => (useTerminalFeed(), dispose))
  expect(observe).toHaveBeenCalledWith({ cwd: "/tmp/x" })
  first.snapshot({ cwd: "/tmp/x", terminals: [{ id: "t1", name: "one" }] })
  expect(terminals().map((item) => item.id)).toEqual(["t1"])
  first.update({ type: "terminals_changed", payload: { cwd: "/tmp/x", terminals: [{ id: "t1", name: "one" }, { id: "t2", name: "two" }] } })
  expect(terminals().map((item) => item.id)).toEqual(["t1", "t2"])
  setAgentId("b")
  expect(first.state.released).toBe(1)
  expect(observe).toHaveBeenLastCalledWith({ cwd: "/tmp/y" })
  expect(terminals()).toEqual([])
  dispose()
  expect(second.state.released).toBe(1)
  expect(interval).not.toHaveBeenCalled() // pushed, not polled
})

test("provider subagents follow pushed upserts and removals for the open session, without polling", async () => {
  setAgents({ parent: agent("parent", "idle"), other: agent("other", "idle") })
  setAgentId("parent")
  const descriptor = (id: string, status: string, parent = "parent") => ({ id, parentAgentId: parent, title: "general-purpose", description: `task ${id}`, status })
  const list = spy(spyOn(daemon, "listProviderSubagents")).mockResolvedValue({ subagents: [descriptor("s1", "running")] } as never)
  const feed = fakeFeed()
  const observe = spy(spyOn(daemon, "observeEvents")).mockReturnValue(feed.feed)
  const interval = spy(spyOn(globalThis, "setInterval"))
  const dispose = createRoot((dispose) => (useSubagentFeed(), dispose))
  await tick()
  expect(observe).toHaveBeenCalledWith(["agent.provider_subagents.update"])
  expect(list).toHaveBeenCalledTimes(1)
  expect(subagents().map((entry) => [entry.id, entry.status])).toEqual([["s1", "running"]])
  const send = (payload: unknown) => feed.update({ type: "agent.provider_subagents.update", payload })
  send({ kind: "upsert", subagent: descriptor("s2", "running") })
  send({ kind: "upsert", subagent: descriptor("s1", "completed") })
  expect(subagents().map((entry) => [entry.id, entry.status])).toEqual([["s1", "completed"], ["s2", "running"]])
  expect(runningSubagents()).toBe(1)
  send({ kind: "upsert", subagent: descriptor("x", "running", "other") }) // another session's
  send({ kind: "remove", parentAgentId: "parent", subagentId: "s2" })
  expect(subagents().map((entry) => entry.id)).toEqual(["s1"])
  // The feed coming back after a reconnect lists again; updates weren't replayed meanwhile.
  list.mockResolvedValue({ subagents: [descriptor("s1", "completed"), descriptor("s3", "running")] } as never)
  feed.snapshot({})
  await tick()
  expect(subagents().map((entry) => entry.id)).toEqual(["s1", "s3"])
  expect(interval).not.toHaveBeenCalled()
  dispose()
  expect(feed.state.released).toBe(1)
})

test("an open provider subagent applies pushed items incrementally, dropping what its first page already holds", async () => {
  const row = (seq: number, text: string) => ({ item: { type: "assistant_message", text }, timestamp: "2026-10-20T10:00:00Z", seq })
  const fetch = spy(spyOn(daemon, "fetchProviderSubagentTimeline")).mockResolvedValue({ rows: [row(1, "one"), row(2, "two ")], epoch: "e1", error: null } as never)
  const feed = fakeFeed()
  spy(spyOn(daemon, "observeEvents")).mockReturnValue(feed.feed)
  const timelineUpdate = (seq: number, text: string, extra = {}) => ({
    type: "agent.provider_subagents.update",
    payload: { kind: "timeline", parentAgentId: "p", subagentId: "c", provider: "claude", item: { type: "assistant_message", text }, timestamp: "2026-10-20T10:00:01Z", seq, epoch: "e1", ...extra },
  })
  const opening = openSubagentTimeline("p", "c")
  feed.update(timelineUpdate(2, "two ")) // arrives while the page loads, and is in it
  feed.update(timelineUpdate(3, "three"))
  await opening
  const texts = () => timeline.rows.map((item) => (item.type === "assistant_message" ? item.text : item.type))
  expect(timeline.agentId).toBe("p:c")
  expect(texts()).toEqual(["one", "two three"])
  const rows = timeline.rows
  const revision = timeline.revision
  feed.update(timelineUpdate(4, "!"))
  feed.update(timelineUpdate(4, "!")) // a duplicate seq is ignored
  feed.update(timelineUpdate(9, "other", { subagentId: "elsewhere" }))
  expect(texts()).toEqual(["one", "two three!"])
  expect(timeline.rows).toBe(rows) // folded into the existing rows, not replaced
  expect(timeline.revision).toBeGreaterThan(revision) // so the transcript's memos regroup
  expect(fetch).toHaveBeenCalledTimes(1)
  // A new epoch means the history was rewritten: read it again.
  fetch.mockResolvedValue({ rows: [row(1, "fresh")], epoch: "e2", error: null } as never)
  feed.update(timelineUpdate(5, "x", { epoch: "e2" }))
  await tick()
  expect(texts()).toEqual(["fresh"])
  await openSubagentTimeline("p", "c").catch(() => {}) // reopening releases the previous feed
  expect(feed.state.released).toBeGreaterThanOrEqual(1)
})

test("ctrl+k / ctrl+u arm a Paseo child, and the second press archives it / detaches and opens it", async () => {
  setAgents({ parent: agent("parent", "idle"), kid: agent("kid", "running", { "paseo.parent-agent-id": "parent" }) })
  setAgentId("parent")
  const archive = spy(spyOn(daemon, "archiveAgent")).mockResolvedValue({ archivedAt: "" })
  const detach = spy(spyOn(daemon, "detachAgent")).mockResolvedValue()
  screen = await testRender(() => <Composer />, { width: 100, height: 14 })
  toggleComposer()
  await screen.renderOnce()
  if (screen.captureCharFrame().includes("ctrl+a running")) handleComposerKey(key("a", true)) // an earlier test left "finished" showing
  handleComposerKey(key("k", true))
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("Press ctrl+k again to archive")
  expect(archive).not.toHaveBeenCalled()
  handleComposerKey(key("k", true))
  expect(archive).toHaveBeenCalledWith("kid")
  // Any other key in between disarms.
  handleComposerKey(key("u", true))
  handleComposerKey(key("left"))
  handleComposerKey(key("right"))
  handleComposerKey(key("u", true))
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("Press ctrl+u again to detach")
  expect(detach).not.toHaveBeenCalled()
  handleComposerKey(key("u", true))
  await tick()
  expect(detach).toHaveBeenCalledWith("kid")
  expect(composerOpen()).toBe(false)
  expect(agentId()).toBe("kid")
  setAgentId("parent")
})

test("`!command` runs in a terminal that outlives the command, opens its output, and refreshes on stream activity", async () => {
  setAgents({ a: agent("a", "idle") })
  setAgentId("a")
  const create = spy(spyOn(daemon, "createTerminal")).mockResolvedValue({ terminal: { id: "t1", name: "! ls -la", cwd: "/tmp/x" }, error: null } as never)
  let output = ["first"]
  const capture = spy(spyOn(daemon, "captureTerminal")).mockImplementation((async () => ({ lines: output })) as never)
  let receive: (event: unknown) => void = () => {}
  const stream = fakeFeed()
  const observe = spy(spyOn(daemon, "observeTerminal")).mockImplementation(((_: string, callback: typeof receive) => ((receive = callback), stream.feed)) as never)
  const interval = spy(spyOn(globalThis, "setInterval"))
  const list = fakeFeed()
  spy(spyOn(daemon, "observeTerminals")).mockReturnValue(list.feed)
  const dispose = createRoot((dispose) => (useTerminalFeed(), dispose))
  list.snapshot({ cwd: "/tmp/x", terminals: [{ id: "t1", name: "! ls -la", title: "sh -c (\nls -la\necho done\n)…" }] })
  screen = await testRender(() => <DialogHost />, { width: 100, height: 30 })

  await expect(runShell("/tmp/x", "  ")).rejects.toThrow("Type a command after !")
  expect(create).not.toHaveBeenCalled()
  await runShell("/tmp/x", " ls -la\necho done ")
  const [cwd, name, , options] = create.mock.calls[0]!
  expect([cwd, name]).toEqual(["/tmp/x", "! ls -la"])
  expect(options).toMatchObject({ workspaceId: "w", command: "sh" })
  // The wrapper runs the command, reports its exit code and waits, so Paseo doesn't drop the terminal with the output.
  expect(options!.args![1]).toBe("(\nls -la\necho done\n)\ncode=$?\nprintf '\\n[exit %s]\\n' \"$code\"\nread -r _")
  expect(dialog.isOpen).toBe(true)
  expect(observe.mock.calls[0]![0]).toBe("t1")
  expect(observe.mock.calls[0]![2]).toEqual({ restore: { mode: "live" } })
  await screen.renderOnce()
  await tick()
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("first")
  expect(screen.captureCharFrame()).toContain("! ls -la") // named after the command, whatever title Paseo gives it
  expect(capture).toHaveBeenCalledTimes(1)

  output = ["first", "second", "[exit 0]"]
  receive({ type: "output", terminalId: "t1", subscriptionId: "s", data: new Uint8Array() })
  receive({ type: "output", terminalId: "t1", subscriptionId: "s", data: new Uint8Array() })
  await tick(150)
  await screen.renderOnce()
  expect(capture).toHaveBeenCalledTimes(2) // a burst is one capture
  expect(screen.captureCharFrame()).toContain("second")
  expect(interval).not.toHaveBeenCalled()
  // Output from before the stream attached (or while it was down) is only in the next capture.
  output = ["first", "second", "third", "[exit 0]"]
  stream.snapshot({ error: null, slot: 1 })
  await tick(150)
  await screen.renderOnce()
  expect(capture).toHaveBeenCalledTimes(3)
  expect(screen.captureCharFrame()).toContain("third")
  dialog.clear()
  expect(stream.state.released).toBe(1)
  dispose()
})

test("`!command` on the home screen opens the directory's workspace first", async () => {
  setAgentId(undefined)
  const open = spy(spyOn(daemon, "openProject")).mockResolvedValue({ workspace: { id: "w9" }, error: null } as never)
  const create = spy(spyOn(daemon, "createTerminal")).mockResolvedValue({ terminal: { id: "t2", name: "! pwd" }, error: null } as never)
  spy(spyOn(daemon, "captureTerminal")).mockResolvedValue({ lines: [] } as never)
  spy(spyOn(daemon, "observeTerminal")).mockReturnValue(fakeFeed().feed)
  await runShell("/tmp/home", "pwd")
  expect(open).toHaveBeenCalledWith("/tmp/home")
  expect(create.mock.calls[0]![3]).toMatchObject({ workspaceId: "w9" })
  create.mockResolvedValue({ terminal: null, error: "no workspace" } as never)
  await expect(runShell("/tmp/home", "pwd")).rejects.toThrow("no workspace")
})

const press = (name: string, ctrl = false, sequence = name) => new KeyEvent({ name, ctrl, meta: false, shift: false, option: false, sequence, number: false, raw: sequence, eventType: "press", source: "raw" })

test("<leader>o opens a pane on the newest shell, streams into the emulator, forwards keys and releases focus", async () => {
  setAgents({ a: agent("a", "idle") })
  setAgentId("a")
  const list = fakeFeed()
  spy(spyOn(daemon, "observeTerminals")).mockReturnValue(list.feed)
  const dispose = createRoot((dispose) => (useTerminalFeed(), registerTerminalCommands(), dispose))
  list.snapshot({ cwd: "/tmp/x", terminals: [{ id: "sh1", name: "pasode" }, { id: "bang", name: "! ls" }] })
  let receive: (event: unknown) => void = () => {}
  const stream = fakeFeed()
  const observe = spy(spyOn(daemon, "observeTerminal")).mockImplementation(((_: string, callback: typeof receive) => ((receive = callback), stream.feed)) as never)
  const input = spy(spyOn(daemon, "sendTerminalInput")).mockImplementation(() => {})
  screen = await testRender(() => <Composer />, { width: 80, height: 30 })

  runCommand("terminal.toggle")
  await tick()
  await screen.renderOnce()
  await screen.renderOnce()
  // `!` terminals hold finished commands; the pane takes the newest real shell.
  expect(observe.mock.calls[0]![0]).toBe("sh1")
  const claim = input.mock.calls.find(([, message]) => message.type === "resize")![1] as { rows: number; cols: number; intent: string }
  expect(claim.intent).toBe("claim")
  expect(observe.mock.calls[0]![2]).toEqual({ restore: { mode: "visible-snapshot", scrollbackLines: 200, size: { rows: claim.rows, cols: claim.cols } } })
  expect(claim.cols).toBeGreaterThan(60)
  expect(paneFocused()).toBe(true)
  expect(composerOpen()).toBe(true)

  receive({ type: "restore", terminalId: "sh1", subscriptionId: "s", data: Buffer.from("$ echo hi\r\nhi\r\n$ ") })
  receive({ type: "output", terminalId: "sh1", subscriptionId: "s", data: Buffer.from("\x1b[31mred\x1b[0m") })
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toMatch(/┃ \$ echo hi\s+┃ hi\s+┃ \$ red/)
  expect(screen.captureCharFrame()).toContain("release focus")

  // Keys go to the shell, except the leader, which the app's keymap needs for <leader>o.
  expect(handleComposerKey(press("a"))).toBe(true)
  expect(input).toHaveBeenCalledWith("sh1", { type: "input", data: "a" })
  expect(handleComposerKey(press("c", true, "\x03"))).toBe(true)
  expect(input).toHaveBeenCalledWith("sh1", { type: "input", data: "\x03" })
  expect(handleComposerKey(press("x", true, "\x18"))).toBe(false)

  runCommand("terminal.toggle")
  expect(paneFocused()).toBe(false)
  expect(composerOpen()).toBe(false)
  expect(handleComposerKey(press("a"))).toBe(false)
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("to focus")
  runCommand("terminal.toggle")
  expect(paneFocused()).toBe(true)
  runCommand("terminal.close")
  await screen.renderOnce()
  expect(paneFocused()).toBe(false)
  expect(stream.state.released).toBe(1)
  expect(screen.captureCharFrame()).not.toContain("release focus")
  dispose()
})

test("a shell that exits closes the pane; with no shell, <leader>o creates one", async () => {
  setAgents({ a: agent("a", "idle") })
  setAgentId("a")
  const list = fakeFeed()
  spy(spyOn(daemon, "observeTerminals")).mockReturnValue(list.feed)
  const dispose = createRoot((dispose) => (useTerminalFeed(), registerTerminalCommands(), dispose))
  list.snapshot({ cwd: "/tmp/x", terminals: [] })
  const create = spy(spyOn(daemon, "createTerminal")).mockResolvedValue({ terminal: { id: "new", name: "pasode" }, error: null } as never)
  const stream = fakeFeed()
  spy(spyOn(daemon, "observeTerminal")).mockReturnValue(stream.feed)
  spy(spyOn(daemon, "sendTerminalInput")).mockImplementation(() => {})
  screen = await testRender(() => <Composer />, { width: 80, height: 30 })
  runCommand("terminal.toggle")
  await tick()
  await screen.renderOnce()
  await screen.renderOnce()
  expect(create).toHaveBeenCalledWith("/tmp/x", "pasode", undefined, { workspaceId: "w" })
  expect(paneFocused()).toBe(true)
  stream.update({ type: "terminal_stream_exit", payload: { terminalId: "new" } })
  await screen.renderOnce()
  expect(paneFocused()).toBe(false)
  expect(stream.state.released).toBe(1)
  dispose()
})

/** A pane on a fake shell: returns the pane's pieces so tests can drive the stream and read the keys it sends. */
async function openPane() {
  setAgents({ a: agent("a", "idle") })
  setAgentId("a")
  const list = fakeFeed()
  spy(spyOn(daemon, "observeTerminals")).mockReturnValue(list.feed)
  const dispose = createRoot((dispose) => (useTerminalFeed(), registerTerminalCommands(), dispose))
  list.snapshot({ cwd: "/tmp/x", terminals: [{ id: "sh1", name: "pasode" }] })
  let receive: (event: unknown) => void = () => {}
  spy(spyOn(daemon, "observeTerminal")).mockImplementation(((_: string, callback: typeof receive) => ((receive = callback), fakeFeed().feed)) as never)
  const input = spy(spyOn(daemon, "sendTerminalInput")).mockImplementation(() => {})
  screen = await testRender(() => <Composer />, { width: 80, height: 30 })
  runCommand("terminal.toggle")
  await tick()
  await screen.renderOnce()
  await screen.renderOnce()
  const sent = () => input.mock.calls.filter(([, message]) => message.type === "input").map(([, message]) => (message as { data: string }).data)
  return { dispose, input, sent, receive: (event: unknown) => receive(event) }
}

test("a replayed restore replaces the screen instead of drawing over the old one", async () => {
  const pane = await openPane()
  const { rows, cols } = pane.input.mock.calls.find(([, message]) => message.type === "resize")![1] as { rows: number; cols: number }
  // The daemon's real restore frame for a screen whose first row reads `text`.
  const restore = (text: string) =>
    Buffer.from(renderTerminalSnapshotToAnsi({ cols, rows, scrollback: [], grid: Array.from({ length: rows }, (_, row) => (row ? [] : Array.from(text, (char) => ({ char })))), cursor: { row: 0, col: text.length, hidden: false } } as never))
  pane.receive({ type: "restore", terminalId: "sh1", subscriptionId: "s", data: restore("OLDLONG") })
  await screen!.renderOnce()
  expect(screen!.captureCharFrame()).toContain("┃ OLDLONG")
  pane.receive({ type: "restore", terminalId: "sh1", subscriptionId: "s", data: restore("NEW") }) // a reconnect
  await screen!.renderOnce()
  expect(screen!.captureCharFrame()).toContain("┃ NEW")
  expect(screen!.captureCharFrame()).not.toContain("OLD")
  pane.dispose()
})

test("a remapped terminal.toggle still reaches the keymap while the pane has focus, so it can release", async () => {
  const pane = await openPane()
  const ctrlO = press("o", true, "\x0f")
  const previous = config.keybinds
  try {
    expect(handleComposerKey(ctrlO)).toBe(true) // default <leader>o: ctrl+o is the shell's
    expect(pane.sent()).toEqual(["\x0f"])
    config.keybinds = { ...previous, "terminal.toggle": "ctrl+o" }
    expect(handleComposerKey(ctrlO)).toBe(false)
    expect(handleComposerKey(press("x", true, "\x18"))).toBe(false) // the leader still is
    expect(pane.sent()).toEqual(["\x0f"])
    expect(handleComposerKey(press("a"))).toBe(true)
  } finally {
    config.keybinds = previous
  }
  pane.dispose()
})

test("typed text and Enter in one stdin chunk reach the shell as they were typed", async () => {
  const pane = await openPane()
  const parser = new StdinParser()
  parser.push(Buffer.from("echo x\r\x1b[Ay\r")) // tmux send-keys -l 'echo x⏎↑y⏎' without a pause
  parser.drain((event) => event.type === "key" && handleComposerKey(new KeyEvent(event.key)))
  expect(pane.sent().join("")).toBe("echo x\r\x1b[Ay\r")
  expect(pane.sent().filter((data) => data === "\r")).toHaveLength(2)
  pane.dispose()
})
