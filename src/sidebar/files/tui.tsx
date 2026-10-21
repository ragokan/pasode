// Provenance: OpenCode MIT packages/tui/src/feature-plugins/sidebar/files.tsx.
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import { unwrap } from "solid-js/store"
import type { PasodePlugin } from "../../plugin"
import { aggregateFiles } from "./files"

export default {
  id: "sidebar-files",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const [open, setOpen] = createSignal(true)
      // Rescans the raw rows once per structural change (the timeline's revision) rather than subscribing to every row.
      const list = createMemo(() => props.agent && ctx.paseo.timeline.agentId === props.agent.id
        ? (ctx.paseo.timeline.revision, aggregateFiles(unwrap(ctx.paseo.timeline.rows), props.agent.cwd)) : [])
      return <Show when={list().length > 0}>
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((value) => !value)}>
            <Show when={list().length > 2}><text fg={ctx.theme.text}>{open() ? "▼" : "▶"}</text></Show>
            <text fg={ctx.theme.text}><b>Modified Files</b></text>
          </box>
          <Show when={list().length <= 2 || open()}>
            {/* Index keeps each row's boxes and updates their text; For would remount every row on each rescan's new objects. */}
            <Index each={list()}>{(item) => <box flexDirection="row" gap={1} justifyContent="space-between">
              <text fg={ctx.theme.textMuted} flexGrow={1} flexShrink={1} wrapMode="none">{item().file}</text>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <Show when={item().additions}><text fg={ctx.theme.diffAdded}>+{item().additions}</text></Show>
                <Show when={item().deletions}><text fg={ctx.theme.diffRemoved}>-{item().deletions}</text></Show>
              </box>
            </box>}</Index>
          </Show>
        </box>
      </Show>
    }, 500))
  },
} satisfies PasodePlugin
