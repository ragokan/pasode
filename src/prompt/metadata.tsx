import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { theme } from "../theme"
import type { PromptProps } from "./types"

// Ported from OpenCode v2.0.26 component/prompt/metadata.tsx (MIT).
export function PromptMetadata(props: { agent: PromptProps["agent"]; model: PromptProps["model"] }) {
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => {
    const width = Math.max(0, dimensions().width - (dimensions().width < 44 ? 9 : 13))
    const agent = dimensions().width < 44 ? undefined : props.agent.label
    const provider = dimensions().width < 44 ? "" : props.model.provider
    const candidates = [provider, provider.split(" / ").at(-1) ?? provider, ""].map((provider) => ({
      agent, model: props.model.name, provider, variant: props.model.variant,
    }))
    const fit = candidates.find((candidate) => Bun.stringWidth([
      ...(agent ? [agent, "·"] : []), candidate.model,
      ...(candidate.provider ? [candidate.provider] : []),
      ...(candidate.variant ? ["·", candidate.variant] : []),
    ].join(" ")) <= width)
    if (fit) return fit
    const available = Math.max(9, width - Bun.stringWidth(agent ? `${agent} · ` : "") - Bun.stringWidth(props.model.variant ? ` · ${props.model.variant}` : ""))
    return { agent, model: truncateWidth(props.model.name, available).replace(/\s+…$/, "…"), provider: "", variant: props.model.variant }
  })
  return (
    <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
      <Show when={layout().agent}><text fg={props.agent.color}>{layout().agent}</text></Show>
      <Show when={layout().model}>
        <box flexDirection="row" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
          <Show when={layout().agent}><text fg={theme.textMuted}>·</text></Show>
          <text flexShrink={1} minWidth={0} wrapMode="none" truncate fg={theme.text}>{layout().model}</text>
          <Show when={layout().provider}><text flexShrink={0} fg={theme.textMuted}>{layout().provider}</text></Show>
          <Show when={layout().variant}>
            <text fg={theme.textMuted}>·</text>
            <text fg={theme.warning} attributes={TextAttributes.BOLD}>{layout().variant}</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export function takeWidth(value: string, width: number) {
  let result = ""
  for (const { segment } of graphemes.segment(value)) {
    if (Bun.stringWidth(result + segment) > width) break
    result += segment
  }
  return result
}

function truncateWidth(value: string, width: number) {
  return Bun.stringWidth(value) <= width ? value : `${takeWidth(value, Math.max(0, width - 1))}…`
}
