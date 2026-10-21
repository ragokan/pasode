// Provenance: OpenCode MIT packages/tui/src/feature-plugins/sidebar/todo.tsx.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { unwrap } from "solid-js/store"
import type { PasodePlugin } from "../../plugin"

export default {
  id: "sidebar-todo",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const [open, setOpen] = createSignal(true)
      const list = createMemo(() => {
        const { timeline } = ctx.paseo
        if (timeline.agentId !== props.agent?.id) return []
        // Find the row on the raw rows (per revision), then read just that row through the store so its edits still propagate.
        const row = (timeline.revision, unwrap(timeline.rows).findLastIndex((row) => row.type === "todo"))
        const todo = timeline.rows[row]
        return todo?.type === "todo" ? todo.items : []
      })
      return <Show when={list().some((item) => !item.completed && item.status !== "completed")}>
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((value) => !value)}>
            <Show when={list().length > 2}><text fg={ctx.theme.text}>{open() ? "▼" : "▶"}</text></Show>
            <text fg={ctx.theme.text}><b>Todo</b></text>
          </box>
          <Show when={list().length <= 2 || open()}>
            <For each={list()}>{(item) => <text fg={item.completed || item.status === "completed" ? ctx.theme.textMuted : ctx.theme.text}>
              <span style={{ fg: item.completed || item.status === "completed" ? ctx.theme.success : ctx.theme.textMuted }}>
                {item.completed || item.status === "completed" ? "[✓]" : item.status === "in_progress" ? "[•]" : "[ ]"}
              </span> {item.text}
            </text>}</For>
          </Show>
        </box>
      </Show>
    }, 400))
  },
} satisfies PasodePlugin
