// Provenance: formerly src/metrics.ts and OpenCode-style sidebar rows; UI authored for pasode.
import { createMemo, onCleanup } from "solid-js"
import type { PasodePlugin } from "../../plugin"
import { cacheHit, computeMetrics, formatDelay } from "./metrics"

export default {
  id: "token-metrics",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const metrics = createMemo(() => computeMetrics(ctx.paseo.timeline.agentId === props.agent?.id ? ctx.paseo.timeline.marks : []))
      const cache = () => cacheHit(props.agent?.provider ?? "", props.agent?.lastUsage)
      return <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ctx.theme.text}>Speed</text>
          <text fg={ctx.theme.textMuted}>{metrics().tps === undefined ? "—" : `${metrics().tps!.toFixed(1)} tok/s`}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ctx.theme.text}>Cache</text>
          <text fg={ctx.theme.textMuted}>{cache() === undefined ? "—" : `${Math.round(cache()! * 100)}%`}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ctx.theme.text}>TTFT</text>
          <text fg={ctx.theme.textMuted}>{metrics().ttft === undefined ? "—" : formatDelay(metrics().ttft!)}</text>
        </box>
      </box>
    }, 700))
  },
} satisfies PasodePlugin
