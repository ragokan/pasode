// Provenance: ~/coding/ocode/plugins/usage-sidebar/tui.ts; same left-name/right-countdown layout, no auth code.
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { PasodePlugin } from "@pasode/host"
import { usageWindows } from "./usage"

export default {
  id: "usage-sidebar",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", () => {
      const [now, setNow] = createSignal(Date.now())
      let busy = false
      const refresh = async () => {
        setNow(Date.now())
        if (busy) return
        busy = true
        try { await ctx.paseo.refreshUsage() } catch {} // The host owns reporting/provider errors; never expose credentials.
        finally { busy = false }
      }
      void refresh()
      const timer = setInterval(refresh, 60_000)
      onCleanup(() => clearInterval(timer))
      return <box>
        <For each={[{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }]}>{(provider) => {
          const windows = () => usageWindows(ctx.paseo.usage()?.find((item) => item.providerId === provider.id), now())
          return <box flexDirection="row" width="100%" gap={1}>
            <text fg={ctx.theme.text} width={6} flexShrink={0}>{provider.name}</text>
            <text fg={ctx.theme.text} flexGrow={1} flexShrink={1} flexBasis={0} textAlign="right" wrapMode="word">
              <Show when={windows().length > 0} fallback="—">
                <For each={windows()}>{(window, index) => <>
                  {index() > 0 ? " · " : ""}<span style={{ fg: ctx.theme.textMuted }}>{window.countdown}</span> {window.percent}
                </>}</For>
              </Show>
            </text>
          </box>
        }}</For>
      </box>
    }, 600))
  },
} satisfies PasodePlugin
