import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { App } from "../src/app"
import { runCommand } from "../src/commands"
import { api, openTimeline, setAgents, setTimeline, type PaseoAgent } from "../src/paseo"
import { prefs, setAgentId, setPref } from "../src/state"
import type { AgentTimelineItem } from "../src/timeline"

const all = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...all(child)])
const transcript = (prefix: string, count: number): AgentTimelineItem[] =>
  Array.from({ length: count }, (_, i) => (i % 2 ? { type: "assistant_message", text: `answer ${prefix}${i}` } : { type: "user_message", text: `question ${prefix}${i}` }))

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

/** The real app on a fake session (no daemon): the scroll wiring around the transcript's tail-first window. */
async function openApp(rows: AgentTimelineItem[], paging: { hasOlder: boolean; startCursor?: { epoch: string; seq: number } } = { hasOlder: false }) {
  const screen = await testRender(() => <App />, { width: 100, height: 40 })
  cleanup = () => {
    setAgentId(undefined)
    setTimeline({ agentId: undefined, rows: [], times: [], marks: [], hasOlder: false, startCursor: undefined })
    screen.renderer.destroy()
  }
  const settle = async (ms = 120) => {
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(ms / 4)
      await screen.renderOnce()
    }
  }
  setAgents("fake", { id: "fake", provider: "claude", cwd: "/tmp", status: "idle", updatedAt: new Date().toISOString() } as PaseoAgent)
  setAgentId("fake")
  setTimeline({ agentId: "fake", rows, times: rows.map(() => 1000), marks: [], loading: false, ...paging })
  await settle(300)
  const scroll = all(screen.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable && node.content.getChildren().some((child) => child.id.startsWith("row-")))!
  const mounted = () => scroll.content.getChildren().filter((child) => child.id.startsWith("row-")).map((child) => Number(child.id.slice(4)))
  const row = (index: number) => scroll.content.getChildren().find((child) => child.id === `row-${index}`)!
  return { screen, settle, scroll, mounted, row }
}

test("tail-first transcript: wheel reveal holds the viewport, bottom follows the tail, ctrl+g and jumps reveal", async () => {
  const { screen, settle, scroll, mounted, row } = await openApp(transcript("q", 300))
  expect(mounted()).toHaveLength(40)
  expect(mounted()[0]).toBe(260)

  // Near the top, each wheel step up moves a fixed row by OpenCode's three lines, including the step that mounts the next chunk.
  scroll.scrollTo(scroll.viewport.height + 6)
  await settle()
  const steps: number[] = []
  for (let i = 0; i < 50 && mounted().length === 40; i++) {
    const y = row(280).y
    await screen.mockMouse.scroll(10, 10, "up")
    await settle(60)
    steps.push(row(280).y - y)
  }
  expect(mounted()).toHaveLength(100)
  expect(steps).toEqual(steps.map(() => 3))

  scroll.scrollTo(scroll.scrollHeight)
  await settle()
  expect(mounted()).toHaveLength(40)

  // From the bottom: revealing must not be undone by the bottom-stuck scroll before it moves.
  screen.mockInput.pressKey("g", { ctrl: true })
  await settle(300)
  expect(mounted()).toHaveLength(300)
  expect(scroll.scrollTop).toBe(0)
  expect(screen.captureCharFrame()).toContain("question q0")

  scroll.scrollTo(scroll.scrollHeight)
  await settle()
  expect(mounted()).toHaveLength(40)
  runCommand("session.timeline")
  await settle()
  await screen.mockInput.typeText("question q16")
  await settle()
  screen.mockInput.pressEnter()
  await settle()
  screen.mockInput.pressEnter() // Jump to message, the first of the message actions
  await settle(300)
  expect(mounted()[0]).toBeLessThan(260)
  expect(screen.captureCharFrame().match(/q(\d+)/)?.[1]).toBe(String(mounted()[0]))
}, 30000)

test("a fast wheel burst near the top mounts one chunk per layout, not the whole transcript", async () => {
  const { screen, settle, scroll, mounted } = await openApp(transcript("q", 300))
  scroll.scrollTo(scroll.viewport.height)
  await settle()
  const top = mounted()[0]!
  // A trackpad swipe: wheel events faster than the two frames a reveal waits for.
  for (let i = 0; i < 10; i++) await screen.mockMouse.scroll(10, 10, "up")
  await settle(300)
  expect(mounted()).toHaveLength(100)
  expect(mounted()[0]).toBe(top - 60)
  expect(scroll.scrollTop).toBeGreaterThan(0)
}, 30000)

test("a text selection keeps revealed rows mounted at the bottom", async () => {
  const { screen, settle, scroll, mounted } = await openApp(transcript("q", 100))
  runCommand("messages.first")
  await settle(300)
  expect(mounted()).toHaveLength(100)
  await screen.mockMouse.drag(5, 2, 12, 5) // starts on "question q0"
  await settle()
  expect(screen.renderer.getSelection()?.getSelectedText()).toBeTruthy()
  scroll.scrollTo(scroll.scrollHeight)
  await settle()
  expect(mounted()).toHaveLength(100)
  screen.renderer.clearSelection()
  scroll.scrollBy(-1)
  scroll.scrollTo(scroll.scrollHeight)
  await settle()
  expect(mounted()).toHaveLength(40)
}, 30000)

test("repeated pageup during an older-page request reveals once without moving the screen", async () => {
  const older = transcript("o", 100).map((item, i) => ({ item, timestamp: new Date(1000 + i).toISOString() }))
  let resolve!: (page: { entries: typeof older; hasOlder: boolean; startCursor: null }) => void
  const refetch = mock(() => new Promise((done) => { resolve = done }))
  const ref = spyOn(api.agents, "ref").mockImplementation(() => ({ commands: async () => ({ commands: [] }), timeline: { refetch } }) as never)
  try {
    const { screen, settle, scroll, mounted, row } = await openApp(transcript("n", 30), { hasOlder: true, startCursor: { epoch: "e", seq: 1 } })
    expect(mounted()).toHaveLength(30)
    scroll.scrollTo(0)
    await settle()
    const y = row(0).y
    runCommand("messages.page_up")
    runCommand("messages.page_up")
    runCommand("messages.page_up")
    expect(refetch).toHaveBeenCalledTimes(1)
    resolve({ entries: older, hasOlder: false, startCursor: null })
    await settle(300)
    expect(refetch).toHaveBeenCalledTimes(1)
    // The 30 rows now sit at 100…129, the 40-row tail starts at 90, and 60 more of the older page mount above it.
    expect(mounted()).toHaveLength(100)
    expect(mounted()[0]).toBe(30)
    expect(row(100).y).toBe(y)
    expect(screen.captureCharFrame()).toContain("question n0")
  } finally {
    ref.mockRestore()
  }
}, 30000)

test("an old session's pending page does not block PageUp in the next session", async () => {
  const pending: ((page: unknown) => void)[] = []
  const refetch = mock(() => new Promise((resolve) => pending.push(resolve)))
  const ref = spyOn(api.agents, "ref").mockImplementation(() => ({ commands: async () => ({ commands: [] }), timeline: { refetch } }) as never)
  try {
    const { screen, settle, scroll, mounted } = await openApp(transcript("a", 30), { hasOlder: true, startCursor: { epoch: "a", seq: 1 } })
    scroll.scrollTo(0)
    await settle()
    runCommand("messages.page_up")
    expect(refetch).toHaveBeenCalledTimes(1)

    await openTimeline(undefined)
    setAgents("next", { id: "next", provider: "claude", cwd: "/tmp", status: "idle", updatedAt: new Date().toISOString() } as PaseoAgent)
    setAgentId("next")
    const rows = transcript("b", 30)
    setTimeline({ agentId: "next", rows, times: rows.map(() => 1000), marks: [], hasOlder: true, startCursor: { epoch: "b", seq: 1 } })
    await settle()
    scroll.scrollTo(0)
    await settle()
    runCommand("messages.page_up")
    expect(refetch).toHaveBeenCalledTimes(2)

    // The old request settling must not clear the newer request's guard.
    pending[0]!({ entries: [], hasOlder: false, startCursor: null })
    await settle()
    runCommand("messages.page_up")
    expect(refetch).toHaveBeenCalledTimes(2)
    pending[1]!({ entries: transcript("old", 100).map((item) => ({ item, timestamp: new Date(1000).toISOString() })), hasOlder: false, startCursor: null })
    await settle(300)
    expect(mounted()).toHaveLength(100)
    expect(screen.captureCharFrame()).toContain("question b0")
  } finally {
    await openTimeline(undefined)
    for (const resolve of pending) resolve({ entries: [], hasOlder: false, startCursor: null })
    ref.mockRestore()
  }
}, 30000)

test("the mouse setting reaches the renderer and the animations command toggles the pref", async () => {
  const { screen, settle } = await openApp(transcript("q", 4))
  try {
    setPref("mouse", false)
    await settle()
    expect(screen.renderer.useMouse).toBe(false)
    setPref("mouse", true)
    await settle()
    expect(screen.renderer.useMouse).toBe(true)
    runCommand("app.toggle.animations")
    expect(prefs.animations).toBe(false)
    runCommand("app.toggle.animations")
    expect(prefs.animations).toBe(true)
  } finally {
    setPref("mouse", true)
    setPref("animations", true)
  }
})
