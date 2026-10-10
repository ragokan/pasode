// Provenance: OpenCode MIT packages/tui/src/feature-plugins/sidebar/todo.tsx.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import type { PasodePlugin } from "../../plugin"

export default {
  id: "sidebar-todo",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const [open, setOpen] = createSignal(true)
      const list = createMemo(() => ctx.paseo.timeline.agentId === props.agent?.id
        ? ctx.paseo.timeline.rows.findLast((row) => row.type === "todo")?.items ?? [] : [])
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
