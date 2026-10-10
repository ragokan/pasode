// Provenance: OpenCode MIT packages/tui/src/feature-plugins/sidebar/context.tsx.
import { createMemo, onCleanup } from "solid-js"
import type { PasodePlugin } from "../../plugin"
import { contextUsage } from "./context"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export default {
  id: "sidebar-context",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const usage = createMemo(() => contextUsage(props.agent?.provider ?? "", props.agent?.lastUsage))
      return <box>
        <text fg={ctx.theme.text}><b>Context</b></text>
        <text fg={ctx.theme.textMuted}>{usage().tokens?.toLocaleString() ?? "—"} tokens</text>
        <text fg={ctx.theme.textMuted}>{usage().percent ?? "—"}% used</text>
        <text fg={ctx.theme.textMuted}>{usage().cost === undefined ? "—" : money.format(usage().cost!)} spent</text>
      </box>
    }, 100))
  },
} satisfies PasodePlugin
