import type { ParsedDiffFile } from "@getpaseo/protocol/messages"
import { parsePatch } from "diff"
import { expect, test } from "bun:test"
import { branchLabel, canCommit, canCreatePr, canPull, canPush, checkCounts, kindOf, mergeBlocker, mergeMethods, patchOf, totals, type Pr, type PrPayload, type Status } from "./model"

const file = (over: Partial<ParsedDiffFile> = {}): ParsedDiffFile => ({
  path: "src/a.ts", isNew: false, isDeleted: false, additions: 2, deletions: 1,
  hunks: [{ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4, lines: [
    { type: "header", content: "@@ -1,3 +1,4 @@" },
    { type: "context", content: "line1" },
    { type: "remove", content: "line2" },
    { type: "add", content: "CHANGED" },
    { type: "context", content: "line3" },
    { type: "add", content: "line4" },
  ] }],
  ...over,
})

test("patchOf builds a unified patch the diff parser reads back with the daemon's numbers", () => {
  const [patch] = parsePatch(patchOf(file()))
  expect(patch).toMatchObject({ oldFileName: "a/src/a.ts", newFileName: "b/src/a.ts" })
  expect(patch!.hunks).toHaveLength(1)
  expect(patch!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 })
  expect(patch!.hunks[0]!.lines).toEqual([" line1", "-line2", "+CHANGED", " line3", "+line4"])
})

test("patchOf marks new and deleted files with /dev/null and keeps the old name of a rename", () => {
  const added = patchOf(file({ isNew: true, hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [{ type: "header", content: "@@ -0,0 +1 @@" }, { type: "add", content: "new" }] }] }))
  expect(added).toContain("--- /dev/null\n+++ b/src/a.ts")
  expect(parsePatch(added)[0]!.hunks[0]).toMatchObject({ oldLines: 0, newLines: 1 })
  expect(patchOf(file({ isDeleted: true }))).toContain("--- a/src/a.ts\n+++ /dev/null")
  expect(patchOf(file({ oldPath: "src/old.ts" }))).toContain("--- a/src/old.ts\n+++ b/src/a.ts")
  expect(patchOf(file({ hunks: [] }))).toBe("--- a/src/a.ts\n+++ b/src/a.ts\n")
})

test("kindOf and totals", () => {
  expect([file(), file({ isNew: true }), file({ isDeleted: true }), file({ oldPath: "x.ts" }), file({ oldPath: "src/a.ts" })].map(kindOf)).toEqual(["M", "A", "D", "R", "M"])
  expect(totals([file(), file({ additions: 5, deletions: 0 })])).toEqual({ files: 2, additions: 7, deletions: 1 })
  expect(totals([])).toEqual({ files: 0, additions: 0, deletions: 0 })
})

const status = (over: Partial<Extract<Status, { isGit: true }>> = {}) =>
  ({
    isGit: true, isPaseoOwnedWorktree: false, repoRoot: "/r", mainRepoRoot: null, currentBranch: "feat", isDirty: false, baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 }, aheadOfOrigin: 0, behindOfOrigin: 0, hasRemote: true, remoteUrl: "git@x", upstreamRef: "refs/remotes/origin/feat",
    cwd: "/r", error: null, requestId: "r", ...over,
  }) as Status
const notGit = { isGit: false, isPaseoOwnedWorktree: false, repoRoot: null, currentBranch: null, isDirty: null, baseRef: null, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null, hasRemote: false, remoteUrl: null, cwd: "/x", error: null, requestId: "r" } as Status

test("actions are offered only when the status allows them", () => {
  expect(canCommit(status({ isDirty: true }))).toBe(true)
  expect(canCommit(status())).toBe(false)
  expect(canCommit(notGit)).toBe(false)

  expect(canPush(status({ aheadOfOrigin: 2 }))).toBe(true)
  expect(canPush(status({ aheadOfOrigin: 0 }))).toBe(false)
  expect(canPush(status({ aheadOfOrigin: 2, hasRemote: false }))).toBe(false)
  expect(canPush(status({ aheadOfOrigin: 2, behindOfOrigin: 1 }))).toBe(false)
  // No upstream yet: only a Paseo worktree with commits beyond its base can push (the daemon sets the upstream).
  expect(canPush(status({ aheadOfOrigin: null, aheadBehind: { ahead: 1, behind: 0 } }))).toBe(false)
  expect(canPush(status({ aheadOfOrigin: null, aheadBehind: { ahead: 1, behind: 0 }, isPaseoOwnedWorktree: true } as never))).toBe(true)
  expect(canPush(notGit)).toBe(false)

  expect(canPull(status({ behindOfOrigin: 3 }))).toBe(true)
  expect(canPull(status({ behindOfOrigin: 3, isDirty: true }))).toBe(false)
  expect(canPull(status({ behindOfOrigin: 0 }))).toBe(false)
  expect(canPull(status({ behindOfOrigin: null }))).toBe(false)
  expect(canPull(status({ behindOfOrigin: 3, hasRemote: false }))).toBe(false)
})

test("branchLabel shows ahead/behind against the upstream, else the base", () => {
  expect(branchLabel(status({ aheadOfOrigin: 2, behindOfOrigin: 1 }))).toBe("feat ↑2 ↓1")
  expect(branchLabel(status())).toBe("feat")
  expect(branchLabel(status({ upstreamRef: null, aheadOfOrigin: null, behindOfOrigin: null, aheadBehind: { ahead: 3, behind: 0 } }))).toBe("feat ↑3")
  expect(branchLabel(status({ currentBranch: null }))).toBe("detached HEAD")
})

const pr = (over: Partial<Pr> = {}) =>
  ({ url: "https://x/pull/1", title: "T", state: "open", baseRefName: "main", headRefName: "feat", isMerged: false, isDraft: false, mergeable: "MERGEABLE", checks: [], number: 1, forge: "github", ...over }) as Pr

test("checkCounts classifies check statuses", () => {
  const checks = ["success", "success", "failure", "pending", "in_progress", "skipped", "cancelled"].map((s) => ({ name: s, status: s, url: null }))
  expect(checkCounts({ checks })).toEqual({ passed: 2, failed: 1, pending: 2 })
})

test("mergeBlocker names the first reason a PR can't merge, and is empty when it can", () => {
  const clean = status()
  expect(mergeBlocker(clean, pr())).toBeUndefined()
  expect(mergeBlocker(clean, pr({ isMerged: true, state: "merged" }))).toBe("already merged")
  expect(mergeBlocker(clean, pr({ state: "closed" }))).toBe("pull request is closed")
  expect(mergeBlocker(clean, pr({ isDraft: true }))).toBe("pull request is a draft")
  expect(mergeBlocker(clean, pr({ mergeable: "CONFLICTING" }))).toBe("merge conflicts")
  expect(mergeBlocker(clean, pr({ checks: [{ name: "ci", status: "failure", url: null }] }))).toBe("checks are failing")
  expect(mergeBlocker(clean, pr({ mergeable: "UNKNOWN" }))).toBe("GitHub is still computing mergeability")
  expect(mergeBlocker(status({ isDirty: true }), pr())).toBe("uncommitted changes")
  expect(mergeBlocker(status({ aheadOfOrigin: 1 }), pr())).toBe("unpushed commits")
  expect(mergeBlocker(clean, pr({ github: { mergeStateStatus: "BLOCKED", repository: { squashMergeAllowed: true, mergeCommitAllowed: true, rebaseMergeAllowed: true } } } as never))).toBe("blocked by branch rules or reviews")
})

test("mergeMethods follows the repository policy, and offers all three without one", () => {
  expect(mergeMethods(pr())).toEqual(["squash", "merge", "rebase"])
  expect(mergeMethods(pr({ github: { repository: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false } } } as never))).toEqual(["squash"])
  expect(mergeBlocker(status(), pr({ github: { repository: { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false } } } as never))).toBe("the repository allows no merge method")
})

test("a PR can be created from a branch ahead of its base, when the forge works", () => {
  const forge = (githubFeaturesEnabled: boolean) => ({ githubFeaturesEnabled, status: null }) as PrPayload
  const ahead = status({ aheadBehind: { ahead: 2, behind: 0 } })
  expect(canCreatePr(ahead, forge(true))).toBe(true)
  expect(canCreatePr(ahead, forge(false))).toBe(false)
  expect(canCreatePr(status(), forge(true))).toBe(false)
  expect(canCreatePr(status({ currentBranch: "main", aheadBehind: { ahead: 2, behind: 0 } }), forge(true))).toBe(false)
  expect(canCreatePr(notGit, forge(true))).toBe(false)
})
