import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { DialogHost, dialog } from "../src/dialog"
import { ChangesView, closeChanges, openChanges } from "../src/git/changes"
import { daemon, setAgents, type PaseoAgent } from "../src/paseo"
import { loadPlugins } from "../src/plugin"
import { Sidebar, sidebarFeatures } from "../src/sidebar"
import { setAgentId, setToast, toast } from "../src/state"

let screen: TestRendererSetup | undefined
const spies: { mockRestore(): void }[] = []

type Observer = { snapshot(payload: unknown): void; update(message: unknown): void }
const subscriptions: { cwd: string; compare: { mode: string; baseRef?: string }; release: ReturnType<typeof mock>; observer?: Observer }[] = []
let statusNow: Record<string, unknown>

const file = (path: string, additions: number, deletions: number, over: Record<string, unknown> = {}) => ({
  path, isNew: false, isDeleted: false, additions, deletions, status: "ok",
  hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: [{ type: "header", content: "@@ -1,2 +1,2 @@" }, { type: "remove", content: `old ${path}` }, { type: "add", content: `new ${path}` }, { type: "context", content: "same" }] }],
  ...over,
})
const files = [file("src/a.ts", 3, 1), file("docs/b.md", 0, 4, { isDeleted: true }), file("c.txt", 1, 0, { isNew: true })]
const push = (payload: unknown, index = subscriptions.length - 1) => subscriptions[index]!.observer!.snapshot({ error: null, ...(payload as object) })

beforeEach(() => {
  statusNow = { cwd: "/tmp/g", isGit: true, isPaseoOwnedWorktree: false, currentBranch: "feat", isDirty: true, baseRef: "main", aheadBehind: { ahead: 2, behind: 0 }, aheadOfOrigin: 0, behindOfOrigin: 0, hasRemote: true, upstreamRef: "refs/remotes/origin/feat", error: null }
  const events = { subscriptionId: "e", ready: Promise.resolve({}), subscribe: () => () => {}, release: async () => {} }
  spies.push(
    spyOn(daemon, "observeEvents").mockImplementation((() => events) as never),
    spyOn(daemon, "getCheckoutStatus").mockImplementation((async () => statusNow) as never),
    spyOn(daemon, "checkoutRefresh").mockImplementation((async () => ({ success: true })) as never),
    spyOn(daemon, "observeCheckoutDiff").mockImplementation(((cwd: string, compare: { mode: string }) => {
      const entry = { cwd, compare, release: mock(async () => {}), observer: undefined as Observer | undefined }
      subscriptions.push(entry)
      return { subscriptionId: "d", ready: Promise.resolve({}), release: entry.release, subscribe: (observer: Observer) => ((entry.observer = observer), () => {}) }
    }) as never),
  )
  setAgents("g1", { id: "g1", title: "Git session", status: "idle", cwd: "/tmp/g", provider: "claude", pendingPermissions: [] } as unknown as PaseoAgent)
  setAgentId("g1")
  setToast(undefined)
})
afterEach(() => {
  closeChanges()
  dialog.clear()
  screen?.renderer.destroy()
  screen = undefined
  while (spies.length) spies.pop()!.mockRestore()
  subscriptions.length = 0
  setAgentId(undefined)
})

const open = async (size = { width: 120, height: 30 }) => {
  screen = await testRender(() => <><ChangesView /><DialogHost /></>, size)
  openChanges()
  await screen.renderOnce()
  push({ files })
  await screen.renderOnce()
  await Bun.sleep(0)
  await screen.renderOnce()
}
const frame = () => screen!.captureCharFrame()
const type = async (text: string) => {
  await screen!.mockInput.typeText(text)
  await screen!.renderOnce()
}

test("lists the changed files with +/− counts and shows the selected file's diff; ↓ moves to the next file", async () => {
  await open()
  let out = frame()
  expect(out).toContain("Changes")
  expect(out).toContain("feat")
  expect(out).toContain("uncommitted")
  expect(out).toContain("+4 −5 · 3 files")
  expect(out).toMatch(/M\s+src\/a\.ts\s+\+3 −1/)
  expect(out).toMatch(/D\s+docs\/b\.md\s+−4/)
  expect(out).toMatch(/A\s+c\.txt\s+\+1/)
  expect(out).toContain("new src/a.ts")
  expect(out).not.toContain("new docs/b.md")

  screen!.mockInput.pressArrow("down")
  await screen!.renderOnce()
  await Bun.sleep(0)
  await screen!.renderOnce()
  out = frame()
  expect(out).toContain("old docs/b.md")
  expect(out).not.toContain("new src/a.ts")
})

test("] and [ jump the diff pane between hunks", async () => {
  const lines = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ({ type: "context", content: `${prefix} ctx ${i}` }))
  const long = file("long.ts", 2, 0, {
    hunks: [
      { oldStart: 1, oldCount: 29, newStart: 1, newCount: 30, lines: [{ type: "header", content: "@@ -1,29 +1,30 @@" }, { type: "add", content: "FIRST HUNK MARKER" }, ...lines("first", 29)] },
      { oldStart: 100, oldCount: 29, newStart: 101, newCount: 30, lines: [{ type: "header", content: "@@ -100,29 +101,30 @@" }, { type: "add", content: "SECOND HUNK MARKER" }, ...lines("second", 29)] },
    ],
  })
  screen = await testRender(() => <><ChangesView /><DialogHost /></>, { width: 120, height: 24 })
  openChanges()
  await screen.renderOnce()
  push({ files: [long] })
  await screen.renderOnce()
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("FIRST HUNK MARKER")
  expect(frame()).not.toContain("SECOND HUNK MARKER")
  await type("]")
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("SECOND HUNK MARKER")
  expect(frame()).not.toContain("FIRST HUNK MARKER")
  await type("[")
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("FIRST HUNK MARKER")
})

test("it is modal: keys never reach what's underneath, and escape closes it and unsubscribes", async () => {
  const underneath = mock(() => {})
  screen = await testRender(() => {
    useRenderer().keyInput.on("keypress", underneath)
    return <><ChangesView /><DialogHost /></>
  }, { width: 120, height: 30 })
  openChanges()
  await screen.renderOnce()
  push({ files })
  await type("jj")
  expect(underneath).not.toHaveBeenCalled()
  screen.mockInput.pressEscape()
  await Bun.sleep(100) // the key parser waits to tell escape from an escape sequence
  await screen.renderOnce()
  expect(frame()).not.toContain("Changes")
  expect(subscriptions[0]!.release).toHaveBeenCalledTimes(1)
  screen.mockInput.pressKey("x")
  expect(underneath).toHaveBeenCalledTimes(1)
})

test("the view closes for good when its session goes away", async () => {
  await open()
  expect(frame()).toContain("Changes")
  setAgentId(undefined)
  await screen!.renderOnce()
  expect(frame()).not.toContain("Changes")
  setAgentId("g1")
  await screen!.renderOnce()
  expect(frame()).not.toContain("Changes")
})

test("tab compares committed work against the base branch (a new subscription), and back", async () => {
  await open()
  expect(subscriptions).toHaveLength(1)
  expect(subscriptions[0]!.compare).toEqual({ mode: "uncommitted" })
  screen!.mockInput.pressTab()
  await screen!.renderOnce()
  await Bun.sleep(0)
  expect(subscriptions).toHaveLength(2)
  expect(subscriptions[1]!.compare).toEqual({ mode: "base", baseRef: "main" })
  expect(subscriptions[0]!.release).toHaveBeenCalledTimes(1)
  push({ files: [] })
  await screen!.renderOnce()
  expect(frame()).toContain("committed vs main")
  expect(frame()).toContain("No commits on this branch beyond main.")
  expect(frame()).not.toContain("discard")
})

test("hints list only the actions the status allows", async () => {
  await open()
  let out = frame()
  expect(out).toContain("c commit")
  expect(out).toContain("d discard file")
  expect(out).not.toContain("p push")
  expect(out).not.toContain("u pull")
  closeChanges()
  screen!.renderer.destroy()
  statusNow = { ...statusNow, isDirty: false, aheadOfOrigin: 2, behindOfOrigin: 0 }
  await open()
  out = frame()
  expect(out).not.toContain("c commit")
  expect(out).toContain("p push")
  expect(out).not.toContain("u pull")
})

test("c asks for a message and commits everything through the daemon", async () => {
  const commit = spyOn(daemon, "checkoutCommit").mockImplementation((async () => ({ success: true, error: null })) as never)
  spies.push(commit)
  await open()
  await type("c")
  expect(frame()).toContain("Commit all changes")
  await type("fix: thing")
  screen!.mockInput.pressEnter()
  await screen!.renderOnce()
  await Bun.sleep(0)
  expect(commit).toHaveBeenCalledWith("/tmp/g", { message: "fix: thing", addAll: true })
  expect(toast()).toMatchObject({ variant: "success", message: "Commit done" })
})

test("a failed push shows the daemon's error; pressing p with nothing to push says so instead of calling it", async () => {
  const pushed = spyOn(daemon, "checkoutPush").mockImplementation((async () => ({ success: false, error: { code: "UNKNOWN", message: "remote rejected" } })) as never)
  spies.push(pushed)
  await open()
  await type("p")
  expect(pushed).not.toHaveBeenCalled()
  expect(toast()).toMatchObject({ variant: "warning" })
  closeChanges()
  screen!.renderer.destroy()
  statusNow = { ...statusNow, isDirty: false, aheadOfOrigin: 1 }
  await open()
  await type("p")
  await Bun.sleep(0)
  expect(pushed).toHaveBeenCalledWith("/tmp/g")
  expect(toast()).toMatchObject({ variant: "error", message: "remote rejected" })
})

test("d discards the selected file after a confirm; D discards every file; cancelling does nothing", async () => {
  const discarded: string[][] = []
  spies.push(spyOn(daemon, "checkoutDiscardChanges").mockImplementation((async (_cwd: string, input: { paths: string[] }) => (discarded.push(input.paths), { success: true, error: null })) as never))
  await open()
  await type("d")
  expect(frame()).toContain("Discard src/a.ts?")
  screen!.mockInput.pressArrow("right") // Cancel
  screen!.mockInput.pressEnter()
  await screen!.renderOnce()
  expect(discarded).toEqual([])

  await type("d")
  screen!.mockInput.pressEnter() // Confirm is the default
  await screen!.renderOnce()
  await Bun.sleep(0)
  expect(discarded).toEqual([["src/a.ts"]])

  await type("D")
  expect(frame()).toContain("all 3 changed files")
  screen!.mockInput.pressEnter()
  await screen!.renderOnce()
  await Bun.sleep(0)
  expect(discarded.at(-1)).toEqual(["src/a.ts", "docs/b.md", "c.txt"])
})

test("not a git repository, binary and oversized diffs get a message instead of a diff", async () => {
  statusNow = { ...statusNow, isGit: false, currentBranch: null }
  await open()
  expect(frame()).toContain("is not a git repository")
  closeChanges()
  screen!.renderer.destroy()
  statusNow = { ...statusNow, isGit: true }
  screen = await testRender(() => <><ChangesView /><DialogHost /></>, { width: 120, height: 30 })
  openChanges()
  await screen.renderOnce()
  push({ files: [file("img.png", 0, 0, { status: "binary", hunks: [] }), file("big.ts", 0, 0, { status: "too_large", hunks: [] })] })
  await screen.renderOnce()
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("Binary file.")
  screen.mockInput.pressArrow("down")
  await screen.renderOnce()
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("Diff too large to show.")
})

test("sidebar Git section: branch with ahead/behind and live change counts; hidden outside a repo", async () => {
  const agent = { id: "g1", title: "Fixture", status: "idle", cwd: "/tmp/g", provider: "claude", pendingPermissions: [] } as unknown as PaseoAgent
  statusNow = { ...statusNow, aheadOfOrigin: 2, behindOfOrigin: 1 }
  screen = await testRender(() => {
    void loadPlugins(useRenderer(), sidebarFeatures)
    return <Sidebar agent={agent} />
  }, { width: 40, height: 60 })
  await screen.renderOnce()
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(frame()).toContain("Git")
  expect(frame()).toContain("feat ↑2 ↓1")
  expect(frame()).toContain("no changes")
  push({ files })
  await screen.renderOnce()
  expect(frame()).toContain("+4 −5 · 3 files")
  expect(frame().indexOf("Context")).toBeLessThan(frame().indexOf("Git"))
  expect(frame().indexOf("Git")).toBeLessThan(frame().indexOf("Speed"))
  push({ files: [files[0]!] })
  await screen.renderOnce()
  expect(frame()).toContain("+3 −1 · 1 file")
})
