// Pure git helpers: patch text for OpenTUI's <diff>, change counts, and which actions a checkout status allows
// (the rules the Paseo app's git/policy.ts applies).
import type { ParsedDiffFile } from "@getpaseo/protocol/messages"
import type { daemon } from "../paseo"

export type Status = Awaited<ReturnType<typeof daemon.getCheckoutStatus>>
export type PrPayload = Awaited<ReturnType<typeof daemon.checkoutPrStatus>>
export type Pr = NonNullable<PrPayload["status"]>

/** Unified patch for one file. Hunk numbers come from the daemon's parsed header, bodies from its typed lines. */
export function patchOf(file: ParsedDiffFile) {
  const out = [`--- ${file.isNew ? "/dev/null" : `a/${file.oldPath ?? file.path}`}`, `+++ ${file.isDeleted ? "/dev/null" : `b/${file.path}`}`]
  for (const hunk of file.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) if (line.type !== "header") out.push((line.type === "add" ? "+" : line.type === "remove" ? "-" : " ") + line.content)
  }
  return out.join("\n") + "\n"
}

/** Repo paths to hand the daemon for these files: a rename touches both its new and its old path. */
export const pathsOf = (files: readonly ParsedDiffFile[]) => [...new Set(files.flatMap((file) => [file.path, file.oldPath ?? file.path]))]

export const kindOf = (file: ParsedDiffFile) => (file.isNew ? "A" : file.isDeleted ? "D" : file.oldPath && file.oldPath !== file.path ? "R" : "M")

export function totals(files: readonly ParsedDiffFile[]) {
  return { files: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) }
}

/** `branch ↑2 ↓1`: against the upstream, else (a Paseo worktree before its first push) the base branch. */
export function branchLabel(status: Status) {
  const ahead = status.aheadOfOrigin ?? (status.upstreamRef ? 0 : (status.aheadBehind?.ahead ?? 0))
  const behind = status.behindOfOrigin ?? 0
  return [status.currentBranch ?? "detached HEAD", ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(" ")
}

const behind = (status: Status) => status.behindOfOrigin ?? 0

export const canCommit = (status: Status) => status.isGit && status.isDirty === true
export const canPull = (status: Status) => status.isGit && status.hasRemote && !status.isDirty && behind(status) > 0
export const canPush = (status: Status) => {
  if (!status.isGit || !status.hasRemote || behind(status) > 0) return false
  if ((status.aheadOfOrigin ?? 0) > 0) return true
  // A Paseo worktree with no upstream yet is pushable: the daemon's push sets the upstream.
  return status.isPaseoOwnedWorktree && status.aheadOfOrigin === null && (status.aheadBehind?.ahead ?? 0) > 0
}

export type Checks = { passed: number; failed: number; pending: number }
export function checkCounts(pr: Pick<Pr, "checks">): Checks {
  const counts = { passed: 0, failed: 0, pending: 0 }
  for (const check of pr.checks) {
    if (check.status === "success") counts.passed++
    else if (check.status === "failure") counts.failed++
    else if (check.status !== "skipped" && check.status !== "cancelled") counts.pending++
  }
  return counts
}

/** Merge methods the repository allows; forges that report no policy offer all three. */
export function mergeMethods(pr: Pick<Pr, "github">) {
  const policy = pr.github?.repository
  const all = [
    { method: "squash", allowed: policy?.squashMergeAllowed },
    { method: "merge", allowed: policy?.mergeCommitAllowed },
    { method: "rebase", allowed: policy?.rebaseMergeAllowed },
  ] as const
  return all.filter((item) => !policy || item.allowed).map((item) => item.method)
}

/** Why the PR can't be merged yet (open, not a draft, no conflicts or blocking state, nothing failing, branch pushed); undefined = it can. */
export function mergeBlocker(status: Status, pr: Pr): string | undefined {
  const state = pr.github?.mergeStateStatus
  if (pr.isMerged || pr.state === "merged") return "already merged"
  if (pr.state !== "open") return `pull request is ${pr.state}`
  if (pr.isDraft) return "pull request is a draft"
  if (pr.mergeable === "CONFLICTING" || state === "DIRTY") return "merge conflicts"
  if (checkCounts(pr).failed) return "checks are failing"
  if (state === "BLOCKED") return "blocked by branch rules or reviews"
  if (pr.mergeable !== "MERGEABLE") return "GitHub is still computing mergeability"
  if (status.isGit && status.isDirty) return "uncommitted changes"
  if (status.isGit && (status.aheadOfOrigin ?? 0) > 0) return "unpushed commits"
  if (!mergeMethods(pr).length) return "the repository allows no merge method"
}

/** A branch with commits beyond its base can open a PR when the forge is usable. */
export const canCreatePr = (status: Status, pr: PrPayload) =>
  pr.githubFeaturesEnabled && status.isGit && status.currentBranch !== status.baseRef && (status.aheadBehind?.ahead ?? 0) > 0
