import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { produce } from "solid-js/store"
import { commandBindings, runCommand } from "../src/commands"
import { kvGet } from "../src/config"
import { createKeymap } from "../src/keys"
import { agents, api, openTimeline, setAgents, setWorkspaceTitles, type PaseoAgent } from "../src/paseo"
import { rendererOptions } from "../src/renderer"
import { agentId, setAgentId, setPref } from "../src/state"
import { registerTabs, TabBar, tabs } from "../src/tabs"

const agent = (id: string, title: string, extra: Partial<PaseoAgent> = {}) =>
  ({ id, title, status: "idle", provider: "claude", cwd: "/tmp", pendingPermissions: [], requiresAttention: false, ...extra }) as PaseoAgent

let screen: TestRendererSetup | undefined
let ref: ReturnType<typeof spyOn> | undefined
// Other test files leave effects on the shared stores (e.g. one reads agents.a), so these tests only add and remove their own "tab-*" entries.
const add = (...list: PaseoAgent[]) => list.forEach((item) => setAgents(item.id, item))
// navigate() opens a timeline; a daemon that never answers keeps that out of the test.
beforeEach(() => {
  ref = spyOn(api.agents, "ref").mockImplementation(() => ({ timeline: { subscribe: () => Object.assign(() => {}, { ready: new Promise(() => {}) }) } }) as never)
  setPref("animations", false)
  setPref("tabs", true)
  setAgentId(undefined)
  // The prune effect only runs against a synced (non-empty) store.
  add(agent("tab-seed", "Seed"))
})
afterEach(async () => {
  screen?.renderer.destroy()
  screen = undefined
  await openTimeline(undefined)
  ref?.mockRestore()
  setPref("animations", true)
  setAgents(produce((all) => Object.keys(all).filter((id) => id.startsWith("tab-")).forEach((id) => delete all[id])))
  setWorkspaceTitles(produce((all) => delete all["tab-w"]))
})

// The open list outlives each test (it's kv-backed), so mount before adding agents: the prune effect then clears
// the previous test's dead ids instead of finding them alive again.
async function mount(width = 80) {
  screen = await testRender(() => (registerTabs(), (<TabBar />)), { ...rendererOptions, width, height: 4 })
  await settle()
}
const settle = async () => {
  await screen!.renderOnce()
  await screen!.renderOnce()
}
const bar = () => screen!.captureCharFrame().split("\n")[0]!

test("the bar lists the sessions opened here, numbered, with a marker per state; the current one has no unread dot", async () => {
  await mount()
  add(
    agent("tab-a", "First chat"),
    agent("tab-b", "Needs input", { pendingPermissions: [{}] as never }),
    agent("tab-c", "Broke", { status: "error" }),
    agent("tab-d", "Finished", { requiresAttention: true }),
    agent("tab-e", "Busy", { status: "running" }),
  )
  for (const id of ["tab-a", "tab-b", "tab-c", "tab-d", "tab-e"]) setAgentId(id)
  setAgentId("tab-d")
  await settle()
  const line = bar()
  expect(line).toMatch(/1 First chat\s+2 Needs input\s*△\s+3 Broke\s+✕\s+4 Finished\s+5 Busy\s+⋯/)
  expect(line).not.toContain("●")
  setAgentId("tab-a")
  await settle()
  expect(bar()).toMatch(/4 Finished\s+●/)
})

test("a session shows under its workspace title, like the sessions list", async () => {
  await mount()
  add(agent("tab-a", "agent title", { workspaceId: "tab-w" }), agent("tab-b", "Other"))
  setWorkspaceTitles("tab-w", "Workspace title")
  setAgentId("tab-a")
  setAgentId("tab-b")
  await settle()
  expect(bar()).toContain("1 Workspace title")
})

test("clicking a tab opens it", async () => {
  await mount()
  add(agent("tab-a", "First chat"), agent("tab-b", "Second chat"))
  setAgentId("tab-a")
  setAgentId("tab-b")
  await settle()
  expect(bar().indexOf("2 Second")).toBeGreaterThan(0)
  await screen!.mockMouse.click(bar().indexOf("1 First") + 1, 0)
  await settle()
  expect(agentId()).toBe("tab-a")
})

test("one session, a very narrow terminal, or the pref off hides the bar", async () => {
  await mount()
  add(agent("tab-a", "First chat"), agent("tab-b", "Second chat"))
  setAgentId("tab-a")
  await settle()
  expect(bar().trim()).toBe("")
  setAgentId("tab-b")
  await settle()
  expect(bar()).toContain("Second chat")
  setPref("tabs", false)
  await settle()
  expect(bar().trim()).toBe("")
  setPref("tabs", true)
  screen!.resize(30, 4)
  await settle()
  expect(bar().trim()).toBe("")
  screen!.resize(60, 4)
  await settle()
  expect(bar()).toContain("Second chat")
})

test("a bar too narrow for every tab scrolls to the current one and counts the rest", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `tab-${i}`)
  await mount(50)
  add(...ids.map((id, i) => agent(id, `Chat number ${i}`)))
  for (const id of ids) setAgentId(id)
  await settle()
  expect(bar()).toMatch(/^‹\d+ /)
  expect(bar()).toContain("8 Chat")
  expect(bar()).not.toContain("1 Chat")
  setAgentId("tab-0")
  await settle()
  expect(bar()).toMatch(/1 Chat.* \d+›\s*$/)
})

test("tab commands jump, cycle and close; the leader keys reach them", async () => {
  await mount()
  add(agent("tab-a", "First chat"), agent("tab-b", "Second chat"), agent("tab-c", "Third chat"))
  for (const id of ["tab-a", "tab-b", "tab-c"]) setAgentId(id)
  await settle()
  const keymap = createKeymap(commandBindings)
  const press = (name: string) => {
    keymap.feed({ name: "x", ctrl: true, shift: false, meta: false, super: false })
    const id = keymap.feed({ name, ctrl: false, shift: false, meta: false, super: false })
    if (id && id !== "pending") runCommand(id)
    return id
  }
  expect(press("1")).toBe("session.tab.select.1")
  expect(agentId()).toBe("tab-a")
  expect(press(".")).toBe("session.tab.next")
  expect(agentId()).toBe("tab-b")
  press(",")
  press(",")
  expect(agentId()).toBe("tab-c") // wraps backwards from the first
  expect(press("9")).toBeUndefined() // no ninth tab: the command is disabled
  expect(agentId()).toBe("tab-c")

  setAgentId("tab-b")
  runCommand("session.tab.close")
  await settle()
  expect(agentId()).toBe("tab-c")
  expect(tabs()).toEqual(["tab-a", "tab-c"])
  expect(kvGet<string[]>("tabs", [])).toEqual(["tab-a", "tab-c"])
  expect(Object.keys(agents)).toContain("tab-b") // closing a tab doesn't archive
  setAgentId("tab-b")
  await settle()
  expect(tabs()).toEqual(["tab-a", "tab-c", "tab-b"]) // opening it again re-adds it
  runCommand("session.tab.close")
  runCommand("session.tab.close") // the next current tab closes too
  runCommand("session.tab.close")
  await settle()
  expect(tabs()).toEqual([])
  expect(agentId()).toBeUndefined() // closing the last tab goes home
})

test("archived sessions drop out of the bar and out of kv", async () => {
  await mount()
  add(agent("tab-a", "First chat"), agent("tab-b", "Second chat"), agent("tab-c", "Third chat"))
  for (const id of ["tab-a", "tab-b", "tab-c"]) setAgentId(id)
  await settle()
  setAgents(produce((all) => delete all["tab-b"]))
  await settle()
  expect(bar()).not.toContain("Second chat")
  expect(bar()).toMatch(/1 First chat\s+2 Third chat/)
  expect(kvGet<string[]>("tabs", [])).toEqual(["tab-a", "tab-c"])
})

test("the open tabs persist: a fresh load keeps those that still exist", async () => {
  await mount()
  add(agent("tab-a", "First chat"), agent("tab-b", "Second chat"))
  setAgentId("tab-a")
  setAgentId("tab-b")
  await settle()
  expect(kvGet<string[]>("tabs", [])).toEqual(["tab-a", "tab-b"])
  screen!.renderer.destroy()
  setAgents(produce((all) => delete all["tab-a"]))
  // A second evaluation of the module reads kv like a restarted process; "tab-a" is gone from the daemon.
  const specifier = "../src/tabs.tsx?restarted"
  const restarted = (await import(specifier)) as typeof import("../src/tabs")
  expect(restarted.tabs()).toEqual(["tab-b"])
})
