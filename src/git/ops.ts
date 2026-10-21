// Git operations. Everything goes through the daemon (the session may run on a remote host); outcomes are toasts.
import { dialogs } from "../dialog"
import { daemon } from "../paseo"
import { notify, showError } from "../state"
import { refreshPr, refreshStatus } from "./live"
import type { Pr } from "./model"

type Outcome = { success: boolean; error: { message: string } | null }

async function run(cwd: string, label: string, request: Promise<Outcome>) {
  const result = await request.catch((error: unknown): Outcome => ({ success: false, error: { message: error instanceof Error ? error.message : String(error) } }))
  if (!result.success) return showError(result.error?.message ?? `${label} failed`), false
  notify(`${label} done`, "success")
  void refreshStatus(cwd, true)
  return true
}

/** Commits every change (the daemon stages all); an empty message lets Paseo write one. */
export async function commit(cwd: string) {
  const message = await dialogs.prompt({ title: "Commit all changes", description: "Commit message (empty = Paseo writes one)", placeholder: "fix: …" })
  if (message === undefined) return
  notify("Committing…")
  return run(cwd, "Commit", daemon.checkoutCommit(cwd, { message: message.trim() || undefined, addAll: true }))
}

export function push(cwd: string) {
  notify("Pushing…")
  return run(cwd, "Push", daemon.checkoutPush(cwd))
}

export function pull(cwd: string) {
  notify("Pulling…")
  return run(cwd, "Pull", daemon.checkoutPull(cwd))
}

/** Discards the given repo-relative paths (untracked ones are deleted), after a confirm. */
export async function discard(cwd: string, paths: string[], what: string) {
  if (!paths.length) return
  if (!(await dialogs.confirm("Discard changes", `Discard ${what}? Edits are lost and new files are deleted. This can't be undone.`, "Discard"))) return
  return run(cwd, "Discard", daemon.checkoutDiscardChanges(cwd, { paths }))
}

export async function createPr(cwd: string) {
  const title = await dialogs.prompt({ title: "Create pull request", description: "Title (empty = Paseo writes one)" })
  if (title === undefined) return
  const body = await dialogs.prompt({ title: "Create pull request", description: "Description (empty = Paseo writes one)" })
  if (body === undefined) return
  notify("Creating pull request…")
  const result = await daemon.checkoutPrCreate(cwd, { title: title.trim() || undefined, body: body.trim() || undefined }).catch(showError)
  if (!result) return
  if (result.error) return showError(result.error.message)
  notify(result.url ?? `Created pull request #${result.number}`, "success", "Pull request created")
  void refreshPr(cwd)
  void refreshStatus(cwd, true)
}

/**
 * The merge request carries only the directory and method, so the daemon merges whichever PR the branch has when
 * it arrives (it has no way to be told which). Re-read it just before sending and stop if it isn't the one confirmed.
 */
async function stillPr(cwd: string, pr: Pr) {
  await daemon.checkoutRefresh(cwd).catch(() => {})
  const fresh = await daemon.checkoutPrStatus(cwd).catch(showError)
  if (!fresh) return false
  if (fresh.status?.number === pr.number && fresh.status?.url === pr.url) return true
  notify(`The branch's pull request is no longer #${pr.number ?? ""}; nothing was merged`, "warning")
  return false
}

export async function mergePr(cwd: string, pr: Pr, methods: string[]) {
  const method = methods.length === 1 ? methods[0] : await dialogs.select({ title: "Merge method", options: methods.map((value) => ({ title: value, value })) })
  if (!method) return
  if (!(await dialogs.confirm("Merge pull request", `Merge #${pr.number ?? ""} "${pr.title}" into ${pr.baseRefName} (${method})?`, "Merge"))) return
  if (!(await stillPr(cwd, pr))) return
  notify("Merging…")
  const result = await daemon.checkoutPrMerge(cwd, { method: method as "merge" | "squash" | "rebase" }).catch(showError)
  if (!result) return
  if (!result.success) return showError(result.error?.message ?? "Merge failed")
  notify(`Merged #${pr.number ?? ""} (${method})`, "success")
  void refreshPr(cwd)
  void refreshStatus(cwd, true)
}
