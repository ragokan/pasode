import { onCleanup, Show } from "solid-js"
import type { PasodePlugin } from "../../plugin"
import { useCheckoutDiff, useCheckoutStatus } from "../../git/live"
import { branchLabel, totals } from "../../git/model"

// Branch, ahead/behind and change counts from the daemon's live checkout status and diff; hidden outside a repo.
export default {
  id: "sidebar-git",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const cwd = () => props.agent?.cwd
      const status = useCheckoutStatus(cwd)
      const diff = useCheckoutDiff(cwd, () => ({ mode: "uncommitted" }))
      return <Show when={status()?.isGit ? status() : undefined}>
        {(s) => {
          const sum = () => totals(diff.files)
          return <box>
            <box onMouseDown={() => ctx.commands.run("git.changes")}>
              <text fg={ctx.theme.text}><b>Git</b></text>
            </box>
            <text fg={ctx.theme.textMuted} wrapMode="none">{branchLabel(s())}</text>
            <Show when={sum().files} fallback={<text fg={ctx.theme.textMuted}>no changes</text>}>
              <text fg={ctx.theme.textMuted} wrapMode="none">
                <span style={{ fg: ctx.theme.diffAdded }}>+{sum().additions}</span> <span style={{ fg: ctx.theme.diffRemoved }}>−{sum().deletions}</span> · {sum().files} {sum().files === 1 ? "file" : "files"}
              </text>
            </Show>
          </box>
        }}
      </Show>
    }, 450))
  },
} satisfies PasodePlugin
