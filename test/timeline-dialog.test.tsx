import { testRender } from "@opentui/solid"
import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { dialog, DialogHost } from "../src/dialog"
import { api, daemon, setAgents, setTimeline, type PaseoAgent } from "../src/paseo"
import { rendererOptions } from "../src/renderer"
import { setAgentId, setToast, toast } from "../src/state"
import { TimelineDialog } from "../src/timeline-dialog"

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

// Four prompts on the daemon; only the newest two ("charlie", "delta") are loaded here.
const prompt = (seq: number, at: number, preview: string) => ({ seq, timestamp: new Date(at).toISOString(), preview })
const prompts = [prompt(1, 1000, "alpha"), prompt(3, 2000, "bravo zebra"), prompt(5, 3000, "charlie"), prompt(7, 4000, "delta")]
const older = [
  { item: { type: "user_message", text: "alpha", messageId: "m0" }, timestamp: new Date(1000).toISOString() },
  { item: { type: "assistant_message", text: "a0" }, timestamp: new Date(1001).toISOString() },
  { item: { type: "user_message", text: "bravo zebra", messageId: "m1" }, timestamp: new Date(2000).toISOString() },
  { item: { type: "assistant_message", text: "a1" }, timestamp: new Date(2001).toISOString() },
]

async function open(capabilities: Partial<NonNullable<PaseoAgent["capabilities"]>>) {
  const scrolled: number[] = []
  const refetch = mock(async () => ({ entries: older, hasOlder: false, startCursor: null }))
  const spies = [
    spyOn(daemon, "listAgentTimelinePrompts").mockResolvedValue({ epoch: "e", prompts } as never),
    spyOn(daemon, "searchAgentTimeline").mockImplementation(async ({ query }) => ({ locations: query === "zebra" ? [{ seq: 3, role: "user" }, { seq: 8, role: "assistant" }] : [] }) as never),
    spyOn(api.agents, "ref").mockImplementation(() => ({ timeline: { refetch } }) as never),
  ]
  setAgents("t", { id: "t", provider: "claude", cwd: "/tmp", capabilities } as PaseoAgent)
  setAgentId("t")
  const rows = [
    { type: "user_message", text: "charlie", messageId: "m2" },
    { type: "assistant_message", text: "a2" },
    { type: "user_message", text: "delta", messageId: "m3" },
  ] as const
  setTimeline({ agentId: "t", rows: [...rows], times: [3000, 3001, 4000], marks: [], loading: false, hasOlder: true, startCursor: { epoch: "e", seq: 5 } })
  const screen = await testRender(() => <DialogHost />, { ...rendererOptions, width: 100, height: 40 })
  cleanup = () => {
    dialog.clear()
    setAgentId(undefined)
    setToast(undefined)
    for (const spy of spies) spy.mockRestore()
    screen.renderer.destroy()
  }
  dialog.replace(() => <TimelineDialog scrollToRow={(index) => scrolled.push(index)} restore={() => {}} />, "large")
  const settle = async (ms = 60) => {
    await Bun.sleep(ms)
    await screen.renderOnce()
  }
  await settle()
  return { screen, settle, scrolled, refetch }
}

test("lists every user message of the session, previews loaded ones, and loads older pages to reach the rest", async () => {
  const { screen, settle, scrolled, refetch } = await open({ supportsRewindBoth: true })
  const frame = screen.captureCharFrame()
  for (const text of ["alpha", "bravo zebra", "charlie", "delta"]) expect(frame).toContain(text)
  expect(frame.indexOf("delta")).toBeLessThan(frame.indexOf("alpha")) // newest first
  // Opening doesn't scroll; moving onto a loaded message does, onto an unloaded one doesn't.
  expect(scrolled).toEqual([])
  screen.mockInput.pressArrow("down")
  await settle()
  expect(scrolled).toEqual([0]) // "charlie" is the first loaded row
  screen.mockInput.pressArrow("down")
  await settle()
  expect(scrolled).toEqual([0])

  // "bravo zebra" lives on an older page: selecting it loads that page, then offers the message actions.
  screen.mockInput.pressEnter()
  await settle(150)
  expect(refetch).toHaveBeenCalledTimes(1)
  const actions = screen.captureCharFrame()
  for (const text of ["Message actions", "Jump to message", "Revert to here", "Copy", "Fork from here"]) expect(actions).toContain(text)
  expect(actions).not.toContain("unavailable")
  screen.mockInput.pressEnter() // Jump
  await settle()
  expect(scrolled.at(-1)).toBe(2) // the four older rows now come first: alpha, a0, bravo
  expect(dialog.isOpen).toBe(false)
})

test("typing searches the whole session on the daemon; assistant matches list the prompt of their turn", async () => {
  const { screen, settle } = await open({ supportsRewindBoth: true })
  await screen.mockInput.typeText("zebra")
  await settle(300)
  const frame = screen.captureCharFrame()
  expect(frame).toContain("bravo zebra")
  expect(frame).toContain("delta")
  expect(frame).toContain("in reply")
  expect(frame).not.toContain("alpha")
  expect(frame).not.toContain("charlie")
  expect(daemon.searchAgentTimeline).toHaveBeenCalledWith({ agentId: "t", query: "zebra" })

  await screen.mockInput.typeText("x")
  await settle(300)
  expect(screen.captureCharFrame()).toContain("No messages match")
})

test("revert says why it can't when the provider can't rewind", async () => {
  const { screen, settle } = await open({})
  screen.mockInput.pressEnter() // "delta", loaded
  await settle()
  const frame = screen.captureCharFrame()
  expect(frame).toContain("unavailable: claude sessions can't rewind")
  screen.mockInput.pressArrow("down")
  await settle()
  screen.mockInput.pressEnter()
  await settle()
  expect(toast()).toMatchObject({ variant: "warning", message: "claude sessions can't rewind" })
  expect(dialog.isOpen).toBe(true)
})
