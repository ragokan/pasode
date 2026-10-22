import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { batch } from "solid-js"
import { reconcile } from "solid-js/store"
import { dialog, DialogHost } from "../src/dialog"
import { agents, api, daemon, openTimeline, setAgents, setWorkspacePins, type PaseoAgent } from "../src/paseo"
import { rendererOptions } from "../src/renderer"
import { sessionCommands } from "../src/session-commands"
import { ImportList, SessionList } from "../src/session-list"
import { agentId, setAgentId, setToast, toast } from "../src/state"

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

const agent = (id: string, workspaceId: string, title: string, updatedAt: string, extra: Partial<PaseoAgent> = {}) =>
  ({ id, workspaceId, title, updatedAt, provider: "claude", cwd: "/work/repo", status: "idle", ...extra }) as PaseoAgent

async function show(render: () => ReturnType<typeof SessionList>, spies: { mockRestore(): void }[] = []) {
  // Opening a session subscribes to its timeline; there is no daemon here.
  const timeline = { subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }), refetch: async () => ({ entries: [], hasOlder: false, startCursor: null }) }
  spies.push(spyOn(api.agents, "ref").mockImplementation(() => ({ timeline, commands: async () => ({ commands: [] }) }) as never))
  const screen = await testRender(() => <DialogHost />, { ...rendererOptions, width: 100, height: 40 })
  cleanup = () => {
    dialog.clear()
    setAgents(reconcile({}))
    setWorkspacePins(reconcile({}))
    setAgentId(undefined)
    setToast(undefined)
    for (const spy of spies) spy.mockRestore()
    screen.renderer.destroy()
  }
  // An earlier test's still-pending open fails once the next open releases its subscription; let it, before ours.
  await openTimeline(undefined)
  await Bun.sleep(0)
  setToast(undefined)
  dialog.replace(render, "large")
  const settle = async (ms = 60) => {
    await Bun.sleep(ms)
    await screen.renderOnce()
  }
  await settle()
  return { screen, settle }
}

test("pinned sessions sort into a Pinned category on top, and ctrl+f pins and unpins the selected one", async () => {
  // "old" is the oldest; its workspace is pinned, so it leads. "shared" sits in a workspace of two, which can't be pinned.
  setAgents(reconcile({
    new: agent("new", "w-new", "Newest session", "2026-01-03T00:00:00Z"),
    old: agent("old", "w-old", "Oldest but pinned", "2026-01-01T00:00:00Z"),
    shared: agent("shared", "w-shared", "Shared one", "2026-01-02T00:00:00Z"),
    sibling: agent("sibling", "w-shared", "Shared two", "2026-01-02T00:00:00Z"),
  }))
  setWorkspacePins(reconcile({ "w-old": "2026-01-05T00:00:00Z", "w-shared": "2026-01-05T00:00:00Z" }))
  const pinned = spyOn(daemon, "setWorkspacePinned").mockImplementation(async (_id, value) => ({ pinnedAt: value ? "2026-02-01T00:00:00Z" : null }))
  const { screen, settle } = await show(() => <SessionList />, [pinned])
  let frame = screen.captureCharFrame()
  expect(frame).toContain("Pinned")
  expect(frame.indexOf("Oldest but pinned")).toBeLessThan(frame.indexOf("Newest session"))
  // A pinned workspace shared by two sessions pins neither.
  expect(frame.indexOf("Pinned")).toBeLessThan(frame.indexOf("Oldest but pinned"))
  expect(frame.indexOf("Newest session")).toBeLessThan(frame.indexOf("Shared one"))
  expect(frame).toContain("unpin") // the selected row is the pinned one

  screen.mockInput.pressKey("f", { ctrl: true })
  await settle()
  expect(pinned.mock.calls).toEqual([["w-old", false]])
  expect(screen.captureCharFrame()).not.toContain("Pinned")

  // The list reorders under the cursor; the selection stays on the same session, so the next press pins it again.
  expect(screen.captureCharFrame()).toContain("pin ctrl+f")
  screen.mockInput.pressKey("f", { ctrl: true })
  await settle()
  expect(pinned.mock.calls).toEqual([["w-old", false], ["w-old", true]])
  expect(screen.captureCharFrame()).toContain("Pinned")
})

test("tab switches to the daemon's history, searches it, and opening an archived session restores it", async () => {
  setAgents(reconcile({ live: agent("live", "w1", "A live session", "2026-01-03T00:00:00Z") }))
  const archived = agent("gone", "w2", "Fix the flaky login test", "2026-01-01T00:00:00Z", { archivedAt: "2026-01-02T00:00:00Z" })
  const searches: (string | undefined)[] = []
  const history = spyOn(daemon, "fetchAgentHistory").mockImplementation(async (options) => {
    searches.push(options?.search)
    const entries = [archived, agent("live", "w1", "A live session", "2026-01-03T00:00:00Z")].filter((item) => !options?.search || item.title!.includes(options.search))
    return { entries: entries.map((item) => ({ agent: item })), pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } as never
  })
  const refresh = spyOn(daemon, "refreshAgent").mockResolvedValue({} as never)
  const { screen, settle } = await show(() => <SessionList />, [history, refresh])
  expect(screen.captureCharFrame()).not.toContain("flaky")
  screen.mockInput.pressTab()
  await settle()
  expect(screen.captureCharFrame()).toContain("Session history")
  expect(screen.captureCharFrame()).toContain("claude · repo · archived")

  await screen.mockInput.typeText("flaky")
  await settle(350)
  expect(searches).toEqual([undefined, "flaky"])
  expect(screen.captureCharFrame()).not.toContain("A live session")

  screen.mockInput.pressEnter()
  await settle()
  expect(refresh.mock.calls).toEqual([["gone"]])
  expect(agentId()).toBe("gone")
  expect(agents.gone?.archivedAt).toBeNull() // present in the live list right away
  expect(toast()?.message).toBe("Restored from the archive")
})

test("/resume lists sessions started outside Paseo and imports the chosen one, then opens it", async () => {
  const entry = { providerId: "claude", providerLabel: "Claude", providerHandleId: "h1", cwd: "/work/repo", title: "Port the parser", firstPromptPreview: "port it", lastPromptPreview: null, lastActivityAt: new Date().toISOString() }
  const queries: (string | undefined)[] = []
  const recent = spyOn(daemon, "fetchRecentProviderSessions").mockImplementation(async (options) => (queries.push(options?.query), { entries: [entry], filteredAlreadyImportedCount: 2 }) as never)
  const imported = spyOn(daemon, "importAgent").mockResolvedValue(agent("imp", "w9", "Port the parser", "2026-01-01T00:00:00Z"))
  const { screen, settle } = await show(() => <ImportList />, [recent, imported])
  expect(recent.mock.calls[0]![0]).toMatchObject({ providers: ["claude", "codex"], limit: 50 })
  expect(screen.captureCharFrame()).toContain("Port the parser")
  expect(screen.captureCharFrame()).toContain("Claude · repo")
  screen.mockInput.pressEnter()
  await settle()
  expect(imported.mock.calls).toEqual([[{ providerId: "claude", providerHandleId: "h1", cwd: "/work/repo" }]])
  expect(agentId()).toBe("imp")
  expect(agents.imp).toBeDefined()
})

test("the slash aliases and small commands are registered", () => {
  const list = sessionCommands({ scrollToRow: () => {} })
  const slashes = Object.fromEntries(list.filter((command) => command.slash).map((command) => [command.slash, command.id]))
  expect(slashes).toMatchObject({ resume: "session.import", import: "session.import.alias", continue: "session.list.continue", quit: "app.exit.quit", effort: "variant.list.effort", "copy-id": "session.copy.id" })
  expect(Object.fromEntries(list.filter((command) => command.id.startsWith("session.child.")).map((command) => [command.id, command.keybind]))).toEqual({
    "session.child.next": "<leader>right",
    "session.child.previous": "<leader>left",
  })
})

test("history opens from an empty live list, and the way back works from an empty history", async () => {
  const history = spyOn(daemon, "fetchAgentHistory").mockResolvedValue({ entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } as never)
  const { screen, settle } = await show(() => <SessionList />, [history])
  expect(screen.captureCharFrame()).toContain("No sessions on the daemon yet")
  screen.mockInput.pressTab()
  await settle()
  expect(screen.captureCharFrame()).toContain("Session history")
  screen.mockInput.pressTab()
  await settle()
  expect(screen.captureCharFrame()).toContain("No sessions on the daemon yet")
  expect(screen.captureCharFrame()).not.toContain("Session history")
})

test("opening a history result the live list doesn't hold yet still selects it as the current session", async () => {
  setAgents(reconcile({ live: agent("live", "w1", "A live session", "2026-01-03T00:00:00Z") }))
  const beyond = agent("beyond", "w3", "Older than the live snapshot", "2025-12-01T00:00:00Z") // not archived
  const history = spyOn(daemon, "fetchAgentHistory").mockResolvedValue({ entries: [{ agent: beyond }], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } as never)
  const { screen, settle } = await show(() => <SessionList />, [history])
  screen.mockInput.pressTab()
  await settle()
  screen.mockInput.pressEnter()
  await settle()
  expect(agentId()).toBe("beyond")
  expect(agents.beyond?.title).toBe("Older than the live snapshot")
})

test("a list that filled after it opened keeps the pinned session selected when it is unpinned and drops below a newer one", async () => {
  const pinned = spyOn(daemon, "setWorkspacePinned").mockResolvedValue({ pinnedAt: null })
  const { screen, settle } = await show(() => <SessionList />, [pinned])
  batch(() => {
    setAgents(reconcile({ a: agent("a", "wa", "Pinned older A", "2026-01-01T00:00:00Z"), b: agent("b", "wb", "Newer B", "2026-01-02T00:00:00Z") }))
    setWorkspacePins(reconcile({ wa: "2026-01-03T00:00:00Z" }))
  })
  await settle()
  const frame = screen.captureCharFrame()
  expect(frame.indexOf("Pinned older A")).toBeLessThan(frame.indexOf("Newer B"))
  screen.mockInput.pressKey("f", { ctrl: true })
  await settle()
  expect(pinned.mock.calls).toEqual([["wa", false]])
  const after = screen.captureCharFrame()
  expect(after.indexOf("Newer B")).toBeLessThan(after.indexOf("Pinned older A"))
  screen.mockInput.pressEnter()
  await settle()
  expect(agentId()).toBe("a")
})
