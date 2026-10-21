import { DiffRenderable, type CliRenderer } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSignal } from "solid-js"
import { App } from "../src/app"
import { runCommand } from "../src/commands"
import { daemon, setAgents, setTimeline, type PaseoAgent } from "../src/paseo"
import { setLoadedPlugins } from "../src/plugin"
import { rendererOptions } from "../src/renderer"
import { TimelineRow } from "../src/session"
import { prefs, setAgentId, setPref, setToast, toast } from "../src/state"
import { installUx } from "../src/ux"

type Handler = Parameters<typeof daemon.onAgentAttentionRequired>[0]

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
  const attention = (agentId: string, reason: "finished" | "error" | "permission", body = "Done") =>
    handler!({ agentId, reason, timestamp: "", shouldNotify: false, notification: { title: "Agent finished", body, data: {} } } as never)
  const agent = (id: string, title: string) => setAgents(id, { id, title, provider: "claude", cwd: "/tmp", status: "idle", updatedAt: "" } as PaseoAgent)
  return { renderer, screen, titles, notified, copied, attention, agent }
}

test("background notification: a watched session finishing, failing or asking raises a desktop notification; focus or the pref silences it", async () => {
  const ux = await mount()
  ux.agent("n1", "Fix parser")
  ux.agent("n2", "Other session")
  setAgentId("n1")
  await ux.screen.renderOnce()

  ux.attention("n1", "finished", "Parser fixed.")
  ux.attention("n1", "error", "Encountered an error.")
  ux.attention("n1", "permission", "Run the tests?")
  expect(ux.notified).toEqual([["Parser fixed.", "✓ Fix parser"], ["Encountered an error.", "✕ Fix parser"], ["Run the tests?", "△ Fix parser"]])

  ux.notified.length = 0
  ux.attention("n2", "finished") // never opened here: the Paseo app and phone cover it
  setFocused(true)
  ux.attention("n1", "finished") // the terminal is in front: the screen already shows it
  setFocused(false)
  setPref("notifications", false)
  ux.attention("n1", "finished")
  expect(ux.notified).toEqual([])

  setPref("notifications", true)
  setAgentId("n2") // opening a session starts watching it, and the first one stays watched
  ux.attention("n1", "finished")
  ux.attention("n2", "finished")
  expect(ux.notified).toHaveLength(2)
})

test("inside Warp or Kaku with the warp plugin loaded, its notifications are the only ones", async () => {
  const ux = await mount()
  ux.agent("w1", "Warp session")
  setAgentId("w1")
  setLoadedPlugins([{ id: "warp", spec: "okan-plugins" }])
  ux.attention("w1", "finished") // not in a Warp terminal: the plugin does nothing there, so ours still fires
  expect(ux.notified).toHaveLength(1)
  process.env.TERM_PROGRAM = "Kaku"
  ux.attention("w1", "finished")
  expect(ux.notified).toHaveLength(1)
  setLoadedPlugins([{ id: "warp", spec: "okan-plugins", error: "failed to load" }])
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
  setLoadedPlugins([{ id: "warp", spec: "okan-plugins" }])
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
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(40)
    await screen.renderOnce()
  }
  const lines = screen.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes("copy these words"))
  const x = lines[y]!.indexOf("copy these words")
  expect(y).toBeGreaterThanOrEqual(0)

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
