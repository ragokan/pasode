import { DiffRenderable, type CliRenderer } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSignal } from "solid-js"
import { App } from "../src/app"
import { runCommand } from "../src/commands"
import { daemon, setAgents, setTimeline, type PaseoAgent } from "../src/paseo"
import { setLoadedPlugins } from "../src/plugin"
import { ACK_MS, HEARTBEAT_MS } from "../src/presence"
import { rendererOptions } from "../src/renderer"
import { TimelineRow } from "../src/session"
import { prefs, setAgentId, setPref, setToast, toast } from "../src/state"
import { installUx } from "../src/ux"

type Handler = Parameters<typeof daemon.onAgentAttentionRequired>[0]
type Beat = Parameters<typeof daemon.sendHeartbeat>[0]

const [focused, setFocused] = createSignal(false)
let cleanup: (() => void) | undefined
const restore: (() => void)[] = []
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  for (const undo of restore.splice(0)) undo()
  setAgentId(undefined)
  setLoadedPlugins([])
  setPref("copyOnSelect", true)
  setPref("notifications", true)
  setPref("terminalTitle", true)
  setFocused(false)
  delete process.env.TERM_PROGRAM
})

const spy = <T extends object, K extends keyof T>(target: T, key: K, impl: never) => {
  const s = spyOn(target, key as never).mockImplementation(impl)
  restore.push(() => s.mockRestore())
  return s
}

/** installUx on a bare renderer, with the daemon's attention channel captured instead of connected. */
async function mount() {
  let handler: Handler | undefined
  spy(daemon, "observeEvents", (() => ({ ready: Promise.resolve(), release: async () => {} })) as never)
  spy(daemon, "onAgentAttentionRequired", ((fn: Handler) => ((handler = fn), () => {})) as never)
  spy(Bun, "spawn", (() => { throw new Error("ENOENT") }) as never)
  // The daemon's presence channel, a clock to age it, and the two timers presence uses, captured to fire by hand.
  const beats: Beat[] = []
  spy(daemon, "sendHeartbeat", ((beat: Beat) => void beats.push(beat)) as never)
  const clock = { offset: 0 }
  const realNow = Date.now.bind(Date)
  spy(Date, "now", (() => realNow() + clock.offset) as never)
  const intervals: (() => void)[] = []
  const timeouts: (() => void)[] = []
  let ackId = 0
  const cleared: unknown[] = []
  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  spy(globalThis, "setInterval", ((fn: () => void, ms?: number, ...rest: never[]) => (ms === HEARTBEAT_MS ? (intervals.push(fn), 0) : realSetInterval(fn, ms, ...rest))) as never)
  spy(globalThis, "setTimeout", ((fn: () => void, ms?: number, ...rest: never[]) => (ms === ACK_MS ? (timeouts.push(fn), ++ackId) : realSetTimeout(fn, ms, ...rest))) as never)
  spy(globalThis, "clearTimeout", ((id: never) => (cleared.push(id), realClearTimeout(id))) as never)
  let renderer!: CliRenderer
  const titles: string[] = []
  const notified: [string, string | undefined][] = []
  const copied: string[] = []
  // Spies go on before installUx runs, so its first title is seen too.
  const Host = () => {
    renderer = useRenderer()
    spyOn(renderer, "setTerminalTitle").mockImplementation((title) => void titles.push(title))
    spyOn(renderer, "triggerNotification").mockImplementation((message, title) => (notified.push([message, title]), true))
    spyOn(renderer, "copyToClipboardOSC52").mockImplementation((text) => (copied.push(text), true))
    installUx(renderer, focused)
    return <box />
  }
  const screen = await testRender(() => <Host />, { ...rendererOptions, width: 40, height: 10 })
  cleanup = () => screen.renderer.destroy()
  const attention = (agentId: string, reason: "finished" | "error" | "permission", body = "Done", shouldNotify = true) =>
    handler!({ agentId, reason, timestamp: "", shouldNotify, notification: { title: "Agent finished", body, data: {} } } as never)
  const agent = (id: string, title: string) => setAgents(id, { id, title, provider: "claude", cwd: "/tmp", status: "idle", updatedAt: "" } as PaseoAgent)
  return { renderer, screen, titles, notified, copied, attention, agent, beats, clock, intervals, timeouts, cleared }
}

test("a notification routed here is a desktop notification in the background and a toast in front; the pref silences both", async () => {
  const ux = await mount()
  ux.agent("n1", "Fix parser")
  ux.agent("n2", "Other session")
  setAgentId("n1")
  await ux.screen.renderOnce()

  ux.attention("n1", "finished", "Parser fixed.")
  ux.attention("n1", "error", "Encountered an error.")
  ux.attention("n1", "permission", "Run the tests?")
  ux.attention("n2", "finished", "Other done.") // never opened here, but the daemon picked this client, so nobody else will say it
  expect(ux.notified).toEqual([["Parser fixed.", "✓ Fix parser"], ["Encountered an error.", "✕ Fix parser"], ["Run the tests?", "△ Fix parser"], ["Other done.", "✓ Other session"]])

  ux.notified.length = 0
  setFocused(true)
  setToast(undefined)
  ux.attention("n1", "finished", "All done.") // in front: a toast, not a desktop notification
  expect(ux.notified).toEqual([])
  expect(toast()).toMatchObject({ title: "✓ Fix parser", message: "All done.", variant: "success" })
  setFocused(false)

  setPref("notifications", false)
  setToast(undefined)
  ux.attention("n1", "finished")
  expect(ux.notified).toEqual([])
  expect(toast()).toBeUndefined()
})

test("inside Warp or Kaku with the warp plugin loaded, its notifications are the only ones", async () => {
  const ux = await mount()
  ux.agent("w1", "Warp session")
  setAgentId("w1")
  setLoadedPlugins([{ id: "warp", spec: "custom-plugins" }])
  ux.attention("w1", "finished") // not in a Warp terminal: the plugin does nothing there, so ours still fires
  expect(ux.notified).toHaveLength(1)
  process.env.TERM_PROGRAM = "Kaku"
  ux.attention("w1", "finished")
  expect(ux.notified).toHaveLength(1)
  setLoadedPlugins([{ id: "warp", spec: "custom-plugins", error: "failed to load" }])
  ux.attention("w1", "finished")
  expect(ux.notified).toHaveLength(2)
})

test("the window title follows the session, goes back to pasode on home, and is blanked when the pref is turned off or on exit", async () => {
  const ux = await mount()
  await ux.screen.renderOnce()
  expect(ux.titles.at(-1)).toBe("pasode")
  ux.agent("t1", "Fix parser")
  setAgentId("t1")
  await ux.screen.renderOnce()
  expect(ux.titles.at(-1)).toBe("Fix parser")
  const written = ux.titles.length
  setLoadedPlugins([{ id: "other", spec: "x" }]) // re-runs the title effect without changing the title: not re-sent
  setLoadedPlugins([{ id: "other", spec: "x" }, { id: "another", spec: "y" }])
  expect(ux.titles).toHaveLength(written)
  setLoadedPlugins([])
  setAgentId(undefined)
  expect(ux.titles.at(-1)).toBe("pasode")
  setPref("terminalTitle", false)
  expect(ux.titles.at(-1)).toBe("")
  const count = ux.titles.length
  setAgentId("t1")
  expect(ux.titles).toHaveLength(count) // off means off
  setPref("terminalTitle", true)
  expect(ux.titles.at(-1)).toBe("Fix parser")
  ux.renderer.destroy()
  expect(ux.titles.at(-1)).toBe("")
})

test("with the warp plugin loaded the window title is left to it", async () => {
  const ux = await mount()
  ux.agent("t2", "Fix parser")
  setLoadedPlugins([{ id: "warp", spec: "custom-plugins" }])
  const count = ux.titles.length
  setAgentId("t2")
  await ux.screen.renderOnce()
  expect(ux.titles).toHaveLength(count)
})

test("a finished mouse selection copies its text and says so; the pref turns that off", async () => {
  const ux = await mount()
  const selection = { getSelectedText: () => "selected words", isStart: false, behavior: "cell" as const }
  spyOn(ux.renderer, "getSelection").mockReturnValue(selection as never)
  setToast(undefined)
  ux.renderer.emit("selection", selection)
  await Bun.sleep(10)
  expect(ux.copied).toEqual(["selected words"])
  expect(toast()).toMatchObject({ message: "Copied", variant: "success" })

  setPref("copyOnSelect", false)
  ux.renderer.emit("selection", selection)
  await Bun.sleep(10)
  expect(ux.copied).toHaveLength(1)
})

test("the view toggles flip their prefs", async () => {
  await mount()
  const before = { verbosity: prefs.verbosity, grouping: prefs.grouping, scrollbar: prefs.scrollbar, diffWrap: prefs.diffWrap }
  runCommand("session.verbosity.cycle")
  expect(prefs.verbosity).toBe(({ low: "medium", medium: "high", high: "low" } as const)[before.verbosity])
  runCommand("session.toggle.exploration_grouping")
  expect(prefs.grouping).toBe(before.grouping === "auto" ? "none" : "auto")
  runCommand("session.toggle.scrollbar")
  expect(prefs.scrollbar).toBe(!before.scrollbar)
  runCommand("app.toggle.diffwrap")
  expect(prefs.diffWrap).toBe(before.diffWrap === "word" ? "none" : "word")
  setPref("diffWrap", "word")
  runCommand("session.toggle.scrollbar")
  runCommand("session.verbosity.cycle")
  runCommand("session.verbosity.cycle")
  runCommand("session.toggle.exploration_grouping")
  expect(prefs).toMatchObject({ verbosity: before.verbosity, grouping: before.grouping, scrollbar: before.scrollbar })
})

test("the light/dark toggle persists the mode and reapplies the theme", async () => {
  await mount()
  const before = prefs.themeMode
  runCommand("theme.switch_mode")
  expect(prefs.themeMode).toBe(before === "dark" ? "light" : "dark")
  runCommand("theme.switch_mode")
  expect(prefs.themeMode).toBe(before)
})

test("ctrl+c with a mouse selection copies it and keeps the app open, instead of exiting", async () => {
  spy(Bun, "spawn", (() => { throw new Error("ENOENT") }) as never)
  const screen = await testRender(() => <App />, { ...rendererOptions, width: 100, height: 30 })
  const copied: string[] = []
  spyOn(screen.renderer, "copyToClipboardOSC52").mockImplementation((text) => (copied.push(text), true))
  cleanup = () => {
    setTimeline({ agentId: undefined, rows: [], times: [], marks: [], hasOlder: false, startCursor: undefined })
    screen.renderer.destroy()
  }
  setAgents("sel", { id: "sel", provider: "claude", cwd: "/tmp", status: "idle", updatedAt: new Date().toISOString() } as PaseoAgent)
  setAgentId("sel")
  setTimeline({ agentId: "sel", rows: [{ type: "assistant_message", text: "copy these words" }], times: [1000], marks: [], loading: false, hasOlder: false })
  // Poll rather than a fixed number of frames: under CPU load the row can take longer to mount.
  let lines: string[] = []
  for (let i = 0; i < 50 && !lines.some((line) => line.includes("copy these words")); i++) {
    await Bun.sleep(40)
    await screen.renderOnce()
    lines = screen.captureCharFrame().split("\n")
  }
  const y = lines.findIndex((line) => line.includes("copy these words"))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf("copy these words")

  await screen.mockMouse.drag(x, y, x + "copy these words".length - 1, y)
  await screen.renderOnce()
  expect(screen.renderer.hasSelection).toBe(true)
  expect(copied.at(-1)).toContain("copy these")

  copied.length = 0
  screen.mockInput.pressKey("c", { ctrl: true })
  await Bun.sleep(300) // quit() waits 200 ms before destroying
  await screen.renderOnce()
  expect(screen.renderer.isDestroyed).toBe(false)
  expect(screen.renderer.useMouse).toBe(true)
  expect(screen.renderer.hasSelection).toBe(false)
  expect(copied.at(-1)).toContain("copy these")
})

test("the diff wrap pref decides whether a long diff line wraps or is cut", async () => {
  const edit = { type: "tool_call", callId: "call", name: "edit", status: "completed", error: null, detail: { type: "edit", filePath: "a.txt", oldString: "x\n", newString: `${"word ".repeat(12)}TAIL\n` } } as never
  const screen = await testRender(() => <TimelineRow item={edit} streaming={false} showDetails={false} diffStyle="unified" />, { width: 40, height: 20 })
  cleanup = () => screen.renderer.destroy()
  const diff = () => screen.renderer.root.getChildren()[0]?.getChildren().flatMap((child) => [child, ...child.getChildren()]).find((child) => child instanceof DiffRenderable) as DiffRenderable
  await screen.flush()
  expect(prefs.diffWrap).toBe("word")
  expect(diff().wrapMode).toBe("word")
  expect(screen.captureCharFrame()).toContain("TAIL")
  setPref("diffWrap", "none")
  await screen.flush()
  expect(diff().wrapMode).toBe("none")
  expect(screen.captureCharFrame()).not.toContain("TAIL")
  setPref("diffWrap", "word")
})

test("the daemon's routing decides: another client was picked, or someone is watching the session, so this one stays quiet", async () => {
  const ux = await mount()
  ux.agent("r1", "Fix parser")
  setAgentId("r1")
  setToast(undefined)
  ux.attention("r1", "finished", "Done", false) // just launched, so counted as present: shouldNotify false is a real "not you"
  expect(ux.notified).toEqual([])
  expect(toast()).toBeUndefined()
  expect(ux.timeouts).toHaveLength(0)
  ux.attention("r1", "finished", "Done", true)
  expect(ux.notified).toHaveLength(1)
})

test("a client idle past the daemon's presence window was never counted, so it alerts for sessions opened here that nobody acknowledges", async () => {
  const ux = await mount()
  ux.agent("l1", "Opened here")
  ux.agent("l2", "Never opened")
  setAgentId("l1")
  ux.clock.offset = 151_000 // the daemon's window is 180 s; ours is shorter on purpose

  ux.attention("l2", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(0) // not ours to alert on

  ux.attention("l1", "finished", "Done", false)
  expect(ux.notified).toEqual([]) // not at once: someone viewing it elsewhere acknowledges it first
  expect(ux.timeouts).toHaveLength(1)
  setAgents("l1", "requiresAttention", false)
  ux.timeouts.pop()!()
  expect(ux.notified).toEqual([]) // acknowledged in another client

  setAgents("l1", "requiresAttention", true)
  ux.attention("l1", "finished", "Done", false)
  ux.timeouts.pop()!()
  expect(ux.notified).toEqual([["Done", "✓ Opened here"]]) // nobody did

  setAgents("l1", "requiresAttention", true)
  ux.attention("l1", "finished", "Done", false)
  setFocused(true)
  ux.timeouts.pop()!()
  expect(ux.notified).toHaveLength(1) // looking at the terminal by then
  setFocused(false)

  ux.screen.mockInput.pressKey("a") // typing makes it present again, and the daemon's answer counts
  ux.attention("l1", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(0)
})

test("presence: real focus, the open session and last input are reported the way the Paseo app does, and never fake activity", async () => {
  setFocused(true)
  const ux = await mount()
  const last = () => ux.beats.at(-1)!
  expect(last()).toMatchObject({ deviceType: "web", focusedAgentId: null, appVisible: true })
  const launched = last().lastActivityAt

  ux.agent("h1", "Fix parser")
  ux.clock.offset = 20_000
  setAgentId("h1")
  expect(last()).toMatchObject({ focusedAgentId: "h1", appVisible: true })
  expect(last().lastActivityAt > launched).toBe(true) // opening a session is activity
  const opened = last().lastActivityAt

  ux.clock.offset = 40_000
  setFocused(false)
  expect(last()).toMatchObject({ focusedAgentId: "h1", appVisible: false, lastActivityAt: opened }) // leaving isn't activity
  ux.clock.offset = 90_000
  ux.intervals[0]!() // the periodic beat reports the same idle time: a heartbeat isn't activity
  expect(last()).toMatchObject({ appVisible: false, lastActivityAt: opened })

  setFocused(true)
  expect(last().appVisible).toBe(true)
  expect(last().lastActivityAt > opened).toBe(true) // coming back is
  ux.clock.offset = 100_000
  ux.screen.mockInput.pressKey("a")
  ux.intervals[0]!()
  expect(last().lastActivityAt > launched && new Date(last().lastActivityAt).getTime() >= Date.now()).toBe(true)

  ux.renderer.destroy() // exiting leaves a "not here" behind (the daemon also drops us when the socket closes)
  expect(last().appVisible).toBe(false)
})

test("a heartbeat that can't be sent (daemon not connected) is dropped, not thrown", async () => {
  const ux = await mount()
  spy(daemon, "sendHeartbeat", (() => { throw new Error("Transport not connected") }) as never)
  expect(() => ux.intervals[0]!()).not.toThrow()
})

test("where the warp plugin owns presence (Kaku), pasode sends none; one connection never carries two senders", async () => {
  process.env.TERM_PROGRAM = "Kaku"
  setLoadedPlugins([{ id: "warp", spec: "custom-plugins" }])
  const ux = await mount()
  setAgentId("k1")
  setFocused(true)
  setFocused(false)
  expect(ux.beats).toEqual([])
  expect(ux.intervals).toHaveLength(0)
  ux.attention("k1", "finished", "Done", true)
  expect(ux.notified).toEqual([]) // its notifications are the plugin's too

  setLoadedPlugins([]) // the plugin failed to load: pasode takes over
  expect(ux.beats.length).toBeGreaterThan(0)
  expect(ux.intervals).toHaveLength(1)
})

test("turning notifications off during the 3 s wait cancels the pending fallback alert", async () => {
  const ux = await mount()
  ux.agent("f1", "Opened here")
  setAgentId("f1")
  ux.clock.offset = 151_000
  setAgents("f1", "requiresAttention", true)
  ux.attention("f1", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(1)
  setPref("notifications", false)
  ux.timeouts.pop()!()
  expect(ux.notified).toEqual([])
})

test("pending fallback alerts are cancelled when the app is torn down", async () => {
  const ux = await mount()
  ux.agent("f2", "Opened here")
  setAgentId("f2")
  ux.clock.offset = 151_000
  ux.attention("f2", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(1)
  ux.renderer.destroy() // disposes the app's reactive tree
  expect(ux.cleared).toContain(1) // the id the pending timer was given
})

test("the daemon sends each event twice to a client with the session open (one copy never routed, shouldNotify false): one alert, not two", async () => {
  const ux = await mount()
  ux.agent("d1", "Opened here")
  setAgentId("d1")
  // Picked: the routed copy alerts, and the unrouted copy for a counted client is ignored.
  ux.attention("d1", "finished", "Done", false)
  ux.attention("d1", "finished", "Done", true)
  expect(ux.notified).toHaveLength(1)

  // Idle: both copies say false, and there is one wait for the pair, not one each.
  ux.notified.length = 0
  ux.clock.offset = 151_000
  setAgents("d1", "requiresAttention", true)
  ux.attention("d1", "finished", "Done", false)
  ux.attention("d1", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(1)
  ux.timeouts.pop()!()
  expect(ux.notified).toHaveLength(1)

  // A later event for the same session is its own wait.
  ux.attention("d1", "finished", "Done", false)
  expect(ux.timeouts).toHaveLength(1)
})
