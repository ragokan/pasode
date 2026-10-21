// /pr: the branch's pull request, its checks, and merge / create (the daemon talks to the forge).
import { createMemo, onMount } from "solid-js"
import { copyText } from "../actions"
import { dialog, DialogSelect, type SelectOption } from "../dialog"
import { notify, showError } from "../state"
import { theme } from "../theme"
import { prOf, refreshPr, useCheckoutStatus } from "./live"
import { canCreatePr, checkCounts, mergeBlocker, mergeMethods } from "./model"
import { createPr, mergePr } from "./ops"

type Choice = { kind: "merge" | "create" | "note"; text?: string } | { kind: "link"; url: string }

export function openPr(cwd: string) {
  dialog.replace(() => <PrDialog cwd={cwd} />, "large")
}

function PrDialog(props: { cwd: string }) {
  const status = useCheckoutStatus(() => props.cwd)
  // Registered after the status watch, so the answer lands in the live store.
  onMount(() => void refreshPr(props.cwd))
  const payload = () => prOf(props.cwd)
  const pr = () => payload()?.status ?? undefined
  const color = (state: string) => (state === "success" ? theme.success : state === "failure" ? theme.error : state === "skipped" || state === "cancelled" ? theme.textMuted : theme.warning)

  const options = createMemo<SelectOption<Choice>[]>(() => {
    const s = status()
    const p = pr()
    if (!s || !payload()) return []
    if (!p) return s.isGit && canCreatePr(s, payload()!) ? [{ title: "Create pull request", description: `${s.currentBranch} → ${s.baseRef}`, value: { kind: "create" }, category: "Pull request" }] : []
    const blocker = s.isGit ? mergeBlocker(s, p) : "not a git repository"
    const counts = checkCounts(p)
    return [
      { title: `#${p.number ?? "?"} ${p.title}`, description: `${p.isMerged ? "merged" : p.state}${p.isDraft ? " · draft" : ""} · ${p.headRefName} → ${p.baseRefName}`, footer: "copy link", value: { kind: "link", url: p.url }, category: "Pull request" },
      blocker
        ? { title: "Merge unavailable", description: blocker, value: { kind: "note", text: `Can't merge: ${blocker}` }, category: "Pull request", gutter: () => <text fg={theme.textMuted}>○</text> }
        : { title: "Merge pull request", description: mergeMethods(p).join(" / "), value: { kind: "merge" }, category: "Pull request", gutter: () => <text fg={theme.success}>●</text> },
      ...p.checks.map((check): SelectOption<Choice> => ({
        title: check.name,
        description: check.workflow,
        footer: [check.status, check.duration].filter(Boolean).join(" · "),
        value: check.url ? { kind: "link", url: check.url } : { kind: "note", text: `${check.name}: ${check.status}` },
        category: `Checks · ${counts.passed} passed · ${counts.failed} failed · ${counts.pending} pending`,
        gutter: () => <text fg={color(check.status)}>●</text>,
      })),
    ]
  })
  const emptyText = () => {
    if (!payload()) return "Loading pull request…"
    const p = payload()!
    if (!p.githubFeaturesEnabled) return `No pull request support for this repository (${typeof p.authState === "string" ? p.authState : "no forge access"})`
    return p.error?.message ?? "No pull request for this branch yet"
  }

  return (
    <DialogSelect
      title={pr() ? `Pull request · ${pr()!.headRefName}` : "Pull request"}
      options={options()}
      emptyText={emptyText()}
      search={false}
      onSelect={(option) => {
        const pick = option.value
        if (pick.kind === "link") {
          dialog.clear()
          return void copyText(pick.url).then(() => notify("Copied link", "success"), showError)
        }
        if (pick.kind === "note") return notify(pick.text ?? "", "warning")
        // Read before closing: closing stops the status watch, which drops the PR from the live store.
        const p = pr()
        dialog.clear()
        if (pick.kind === "create") return void createPr(props.cwd)
        if (p) void mergePr(props.cwd, p, mergeMethods(p))
      }}
    />
  )
}
