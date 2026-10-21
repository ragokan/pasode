import { dialogs } from "../dialog"
import { daemon } from "../paseo"

/**
 * Base branch for a new worktree, from the daemon's branch suggestions. "" = the repository's default branch
 * (first row, so enter keeps today's behavior); undefined = cancelled. Not a repo or no answer: the default.
 */
export async function pickBaseBranch(cwd: string) {
  const result = await daemon.getBranchSuggestions({ cwd, limit: 100 }).catch(() => undefined)
  if (!result?.branches.length) return ""
  const details = new Map(result.branchDetails?.map((item) => [item.name, item]))
  return dialogs.select<string>({
    title: "Base branch",
    placeholder: "Search branches",
    options: [
      { title: "Default branch", description: "the repository's default", value: "" },
      ...result.branches.map((name) => ({ title: name, footer: details.get(name)?.hasLocal === false ? "remote" : "local", value: name })),
    ],
  })
}
