import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createSession, newWorktreeDraft } from "../src/actions"
import { dialog, DialogHost, dialogs } from "../src/dialog"
import { watchStatus } from "../src/git/live"
import { openPr } from "../src/git/pr"
import { openWorktrees } from "../src/git/worktrees"
import { daemon, setAgents, type PaseoAgent } from "../src/paseo"
import { agentId, draft, setAgentId, setDraft, setToast, toast } from "../src/state"

let screen: TestRendererSetup | undefined
const spies: { mockRestore(): void }[] = []
const spy = <T extends { mockRestore(): void }>(value: T) => (spies.push(value), value)
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await Bun.sleep(0)
    await screen!.renderOnce()
  }
}
const frame = () => screen!.captureCharFrame()
const mount = async () => {
  screen = await testRender(() => <DialogHost />, { width: 110, height: 40 })
  await screen.renderOnce()
}

const status = { cwd: "/tmp/g", isGit: true, isPaseoOwnedWorktree: false, currentBranch: "feat", isDirty: false, baseRef: "main", aheadBehind: { ahead: 2, behind: 0 }, aheadOfOrigin: 0, behindOfOrigin: 0, hasRemote: true, upstreamRef: "refs/remotes/origin/feat", error: null }
const pr = (over: Record<string, unknown> = {}) => ({
  forge: "github", number: 7, url: "https://github.com/o/r/pull/7", title: "Add thing", state: "open", baseRefName: "main", headRefName: "feat", isMerged: false, isDraft: false, mergeable: "MERGEABLE",
  checks: [{ name: "build", status: "success", url: "https://ci/1", workflow: "CI", duration: "1m" }, { name: "lint", status: "pending", url: null }],
  github: { mergeStateStatus: "CLEAN", repository: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false } },
  ...over,
})

let observers: { snapshot(payload: unknown): void; update(message: unknown): void }[] = []
beforeEach(() => {
  observers = []
  const events = { subscriptionId: "e", ready: Promise.resolve({}), subscribe: (observer: (typeof observers)[number]) => (observers.push(observer), () => {}), release: async () => {} }
  spy(spyOn(daemon, "observeEvents").mockImplementation((() => events) as never))
  spy(spyOn(daemon, "getCheckoutStatus").mockImplementation((async () => status) as never))
  spy(spyOn(daemon, "checkoutRefresh").mockImplementation((async () => ({ success: true })) as never))
  setAgents("g1", { id: "g1", title: "Git session", status: "idle", cwd: "/tmp/g", provider: "claude", pendingPermissions: [] } as unknown as PaseoAgent)
  setAgentId("g1")
  setToast(undefined)
})
afterEach(() => {
  dialog.clear()
  screen?.renderer.destroy()
  screen = undefined
  while (spies.length) spies.pop()!.mockRestore()
  setAgentId(undefined)
})

test("/pr shows the PR, its checks and merges after a confirm, with the repository's only allowed method", async () => {
  spy(spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => ({ cwd: "/tmp/g", status: pr(), githubFeaturesEnabled: true, error: null })) as never))
  const merged: unknown[] = []
  spy(spyOn(daemon, "checkoutPrMerge").mockImplementation((async (_cwd: string, input: unknown) => (merged.push(input), { success: true, error: null })) as never))
  await mount()
  openPr("/tmp/g")
  await settle()
  const out = frame()
  expect(out).toContain("Pull request · feat")
  expect(out).toContain("#7 Add thing")
  expect(out).toContain("open · feat → main")
  expect(out).toContain("Merge pull request")
  expect(out).toContain("squash")
  expect(out).toContain("Checks · 1 passed · 0 failed · 1 pending")
  expect(out).toMatch(/build\s+CI\s+success · 1m/)

  screen!.mockInput.pressArrow("down")
  screen!.mockInput.pressEnter()
  await settle()
  expect(frame()).toContain('Merge #7 "Add thing" into main (squash)?')
  expect(merged).toEqual([])
  screen!.mockInput.pressEnter()
  await settle()
  expect(merged).toEqual([{ method: "squash" }])
  expect(toast()).toMatchObject({ variant: "success", message: "Merged #7 (squash)" })
})

for (const [name, replacement] of [["a different PR", () => pr({ number: 8, url: "https://github.com/o/r/pull/8", title: "Other thing", headRefName: "other" })], ["no PR", () => null]] as const) {
  test(`a merge is refused when the branch has ${name} by the time the confirm is answered`, async () => {
    let answer: unknown = pr()
    spy(spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => ({ cwd: "/tmp/g", status: answer, githubFeaturesEnabled: true, error: null })) as never))
    const merged: unknown[] = []
    spy(spyOn(daemon, "checkoutPrMerge").mockImplementation((async (_cwd: string, input: unknown) => (merged.push(input), { success: true, error: null })) as never))
    await mount()
    openPr("/tmp/g")
    await settle()
    screen!.mockInput.pressArrow("down")
    screen!.mockInput.pressEnter()
    await settle()
    expect(frame()).toContain('Merge #7 "Add thing" into main (squash)?')
    // The daemon would merge whatever PR the directory's branch has when the request lands.
    answer = replacement()
    screen!.mockInput.pressEnter()
    await settle()
    expect(merged).toEqual([])
    expect(toast()).toMatchObject({ variant: "warning", message: "The branch's pull request is no longer #7; nothing was merged" })
  })
}

test("the confirmed PR is a snapshot: a live update rewriting the store's PR during the confirm can't redirect the merge", async () => {
  const other = pr({ number: 8, url: "https://github.com/o/r/pull/8", title: "Other thing", headRefName: "other" })
  let answer: unknown = pr()
  spy(spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => ({ cwd: "/tmp/g", status: answer, githubFeaturesEnabled: true, error: null })) as never))
  const merged: unknown[] = []
  spy(spyOn(daemon, "checkoutPrMerge").mockImplementation((async (_cwd: string, input: unknown) => (merged.push(input), { success: true, error: null })) as never))
  // The sidebar (or the changes view) keeps watching after the dialog closes, so status updates keep rewriting the store's PR in place.
  const stopSidebar = watchStatus("/tmp/g")
  await mount()
  openPr("/tmp/g")
  await settle()
  screen!.mockInput.pressArrow("down")
  screen!.mockInput.pressEnter()
  await settle()
  expect(frame()).toContain('Merge #7 "Add thing" into main (squash)?')
  answer = other
  for (const observer of observers) observer.update({ type: "checkout_status_update", payload: { ...status, subscriptionId: "e", prStatus: { cwd: "/tmp/g", status: other, githubFeaturesEnabled: true, error: null } } })
  screen!.mockInput.pressEnter()
  await settle()
  expect(merged).toEqual([])
  expect(toast()).toMatchObject({ variant: "warning", message: "The branch's pull request is no longer #7; nothing was merged" })
  stopSidebar()
})

test("/pr explains why a PR can't merge instead of offering it, and offers Create when there is none", async () => {
  let answer: unknown = { cwd: "/tmp/g", status: pr({ isDraft: true }), githubFeaturesEnabled: true, error: null }
  spy(spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => answer) as never))
  await mount()
  openPr("/tmp/g")
  await settle()
  expect(frame()).toContain("Merge unavailable")
  expect(frame()).toContain("pull request is a draft")
  expect(frame()).not.toContain("Merge pull request")
  dialog.clear()

  answer = { cwd: "/tmp/g", status: null, githubFeaturesEnabled: true, error: null }
  openPr("/tmp/g")
  await settle()
  expect(frame()).toContain("Create pull request")
  expect(frame()).toContain("feat → main")
  dialog.clear()

  answer = { cwd: "/tmp/g", status: null, githubFeaturesEnabled: false, authState: "no_remote", error: null }
  openPr("/tmp/g")
  await settle()
  expect(frame()).toContain("No pull request support for this repository (no_remote)")
})

test("creating a PR asks for a title and description and calls the daemon", async () => {
  spy(spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => ({ cwd: "/tmp/g", status: null, githubFeaturesEnabled: true, error: null })) as never))
  const created: unknown[] = []
  spy(spyOn(daemon, "checkoutPrCreate").mockImplementation((async (_cwd: string, input: unknown) => (created.push(input), { url: "https://github.com/o/r/pull/9", number: 9, error: null })) as never))
  await mount()
  openPr("/tmp/g")
  await settle()
  screen!.mockInput.pressEnter()
  await settle()
  await screen!.mockInput.typeText("My title")
  screen!.mockInput.pressEnter()
  await settle()
  expect(frame()).toContain("Description")
  screen!.mockInput.pressEnter() // empty = generated
  await settle()
  expect(created).toEqual([{ title: "My title", body: undefined }])
  expect(toast()).toMatchObject({ variant: "success", title: "Pull request created" })
})

const worktrees = [
  { worktreePath: "/home/u/.paseo/worktrees/abc/feat-x", createdAt: new Date().toISOString(), branchName: "feat/x" },
  { worktreePath: "/home/u/.paseo/worktrees/abc/other", createdAt: new Date().toISOString(), branchName: null },
]

test("/worktrees lists Paseo worktrees; enter starts the next session there; ctrl+d archives after a confirm", async () => {
  let list = worktrees
  const listed = spy(spyOn(daemon, "getPaseoWorktreeList").mockImplementation((async () => ({ worktrees: list, error: null })) as never))
  const archived: unknown[] = []
  spy(spyOn(daemon, "archivePaseoWorktree").mockImplementation((async (input: unknown) => (archived.push(input), (list = list.slice(1)), { success: true, error: null })) as never))
  await mount()
  await openWorktrees()
  await settle()
  expect(listed).toHaveBeenCalledWith({ cwd: "/tmp/g" })
  expect(frame()).toContain("feat/x")
  expect(frame()).toContain("other")
  expect(frame()).toContain("ctrl+d")

  await screen!.mockInput.pressKey("d", { ctrl: true })
  await settle()
  expect(frame()).toContain("Archive feat/x?")
  screen!.mockInput.pressArrow("right") // Cancel returns to the list
  screen!.mockInput.pressEnter()
  await settle()
  expect(archived).toEqual([])
  expect(frame()).toContain("feat/x")

  await screen!.mockInput.pressKey("d", { ctrl: true })
  await settle()
  screen!.mockInput.pressEnter()
  await settle()
  expect(archived).toEqual([{ worktreePath: "/home/u/.paseo/worktrees/abc/feat-x", scope: "worktree" }])
  expect(frame()).not.toContain("feat/x")

  // A fork seeded earlier would win in createSession (it prefers fork.cwd), starting the session in the other repo.
  setDraft({ provider: "claude", fork: { title: "Forked", cwd: "/elsewhere", attachment: {} as never } })
  screen!.mockInput.pressEnter()
  await settle()
  expect(draft().cwd).toBe("/home/u/.paseo/worktrees/abc/other")
  expect(draft().fork).toBeUndefined()
  expect(agentId()).toBeUndefined()
  expect(dialog.isOpen).toBe(false)
})

test("/worktree asks for a base branch: enter keeps the default, a pick is sent as the branch-off ref", async () => {
  spy(spyOn(dialogs, "prompt").mockImplementation(async () => "feat/new"))
  spy(spyOn(daemon, "getBranchSuggestions").mockImplementation((async () => ({
    branches: ["main", "develop"], branchDetails: [{ name: "main", committerDate: 2, hasLocal: true }, { name: "develop", committerDate: 1, hasLocal: false, hasRemote: true }], error: null,
  })) as never))
  const sources: unknown[] = []
  spy(spyOn(daemon, "createWorkspace").mockImplementation((async (input: { source: unknown }) => (sources.push(input.source), { agent: { id: "new-agent" } })) as never))
  await mount()
  setAgentId(undefined)

  setDraft({ provider: "claude", model: "m", cwd: "/tmp/repo" })
  let started = newWorktreeDraft()
  await settle()
  expect(frame()).toContain("Base branch")
  expect(frame()).toContain("Default branch")
  expect(frame()).toMatch(/develop\s+remote/)
  screen!.mockInput.pressEnter()
  await started
  expect(draft().worktree).toEqual({ branch: "feat/new", base: undefined })
  await createSession("hi")
  expect(sources.at(-1)).toEqual({ kind: "worktree", cwd: "/tmp/repo", action: "branch-off", branchName: "feat/new" })

  setDraft({ provider: "claude", model: "m", cwd: "/tmp/repo" })
  started = newWorktreeDraft()
  await settle()
  screen!.mockInput.pressArrow("down")
  screen!.mockInput.pressArrow("down")
  screen!.mockInput.pressEnter()
  await started
  expect(draft().worktree).toEqual({ branch: "feat/new", base: "develop" })
  await createSession("hi")
  expect(sources.at(-1)).toEqual({ kind: "worktree", cwd: "/tmp/repo", action: "branch-off", branchName: "feat/new", refName: "develop" })
})

test("cancelling the base branch picker cancels the worktree; no branch list (not a repo) falls back to the default", async () => {
  spy(spyOn(dialogs, "prompt").mockImplementation(async () => ""))
  const suggestions = spy(spyOn(daemon, "getBranchSuggestions").mockImplementation((async () => ({ branches: ["main"], error: null })) as never))
  await mount()
  setAgentId(undefined)
  setDraft({ provider: "claude", model: "m" })
  const started = newWorktreeDraft()
  await settle()
  dialog.clear()
  await started
  expect(draft().worktree).toBeUndefined()

  suggestions.mockImplementation((async () => { throw new Error("not a repo") }) as never)
  await newWorktreeDraft()
  expect(draft().worktree).toEqual({ branch: undefined, base: undefined })
})
