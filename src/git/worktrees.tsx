// /worktrees: the Paseo worktrees of the current repository, with archive and "new session there".
import os from "node:os"
import path from "node:path"
import { dialog, dialogs, DialogSelect } from "../dialog"
import { daemon } from "../paseo"
import { current, draft, navigate, notify, setDraft, showError } from "../state"
import { dayCategory } from "../timeline"

const tilde = (value: string) => value.replace(os.homedir(), "~")

export async function openWorktrees() {
  const cwd = current()?.cwd ?? draft().cwd ?? process.cwd()
  const result = await daemon.getPaseoWorktreeList({ cwd }).catch(showError)
  if (!result) return
  if (result.error) return showError(result.error.message)
  dialog.replace(
    () => (
      <DialogSelect
        title="Worktrees"
        emptyText="No Paseo worktrees for this repository (try /worktree to start a session in a new one)"
        options={result.worktrees.map((item) => ({
          title: item.branchName ?? path.basename(item.worktreePath),
          description: tilde(item.worktreePath),
          footer: dayCategory(item.createdAt),
          value: item.worktreePath,
        }))}
        onSelect={(option) => {
          dialog.clear()
          setDraft({ ...draft(), cwd: option.value, worktree: undefined })
          navigate(undefined)
          notify(`Next session starts in ${tilde(option.value)}`)
        }}
        actions={[
          {
            label: "ctrl+d",
            title: "archive",
            match: (key) => key.ctrl && key.name === "d",
            run: (option) => void archive(option.value, option.title),
          },
        ]}
      />
    ),
    "large",
  )
}

async function archive(worktreePath: string, name: string) {
  const ok = await dialogs.confirm("Archive worktree", `Archive ${name}? Its sessions are archived and ${tilde(worktreePath)} is removed. Uncommitted work there is lost.`, "Archive")
  if (!ok) return void openWorktrees()
  const result = await daemon.archivePaseoWorktree({ worktreePath, scope: "worktree" }).catch(showError)
  if (result?.error) showError(result.error.message)
  else if (result) notify(`Archived ${name}`, "success")
  void openWorktrees()
}
