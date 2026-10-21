import { registerCommands } from "../commands"
import { current } from "../state"
import { openChanges } from "./changes"
import { openPr } from "./pr"
import { openWorktrees } from "./worktrees"

export { ChangesView } from "./changes"

/** Git commands: the changes view (commit/push/pull/discard live in it), the PR dialog and worktrees. */
export function registerGit() {
  registerCommands([
    { id: "git.changes", title: "View changes", category: "Git", keybind: "<leader>v", slash: "changes", enabled: () => !!current(), run: openChanges },
    { id: "git.pr", title: "Pull request", category: "Git", slash: "pr", enabled: () => !!current(), run: () => openPr(current()!.cwd) },
    { id: "git.worktrees", title: "Worktrees", category: "Git", slash: "worktrees", run: () => void openWorktrees() },
  ])
}
