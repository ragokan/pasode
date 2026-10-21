// Provenance: ~/coding/ocode/plugins/usage-sidebar/tui.ts; same left-name/right-countdown layout, no auth code.
// Per-account rows come from ZeroSub (Paseo plugin) when installed, read-only via `zerosub.state`.
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { PasodePlugin } from "@pasode/host"
import { reportAccounts, reportWindows, zeroSubAccounts, type Window, type ZeroSubState } from "./usage"

const PROVIDERS = [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }]

export default {
  id: "usage-sidebar",
  setup(ctx) {
    const Windows = (props: { list: Window[] }) =>
      <text fg={ctx.theme.text} flexGrow={1} flexShrink={1} flexBasis={0} textAlign="right" wrapMode="word">
        <Show when={props.list.length > 0} fallback="—">
          <For each={props.list}>{(window, index) => <>
            {index() > 0 ? " · " : ""}<span style={{ fg: ctx.theme.textMuted }}>{window.countdown}</span> <span style={{ fg: window.stale ? ctx.theme.textMuted : ctx.theme.text }}>{window.percent}</span>
          </>}</For>
        </Show>
      </text>

    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const [now, setNow] = createSignal(Date.now())
      const [zeroSub, setZeroSub] = createSignal<ZeroSubState>()
      let busy = false
      const refresh = async () => {
        setNow(Date.now())
        if (busy) return
        busy = true
        try {
          // Never pass refreshUsage: that makes ZeroSub fetch from the providers; its cached view is enough.
          const state = await ctx.paseo.daemon.invokePluginRpc("zerosub", "zerosub.state", {}).catch(() => undefined) as ZeroSubState | undefined
          setZeroSub(Array.isArray(state?.accounts) && Array.isArray(state?.agents) ? state : undefined)
          if (!zeroSub()) await ctx.paseo.refreshUsage()
        } catch {} // The host owns reporting/provider errors; never expose credentials.
        finally { busy = false }
      }
      void refresh()
      const timer = setInterval(refresh, 60_000)
      onCleanup(() => clearInterval(timer))
      return <box>
        <For each={PROVIDERS}>{(provider) => {
          const reports = () => ctx.paseo.usage()?.filter((entry) => entry.sourceId === provider.id) ?? []
          const accounts = () => {
            const state = zeroSub()
            if (state) return zeroSubAccounts(state, props.agent?.id, now()).filter((account) => account.family === provider.id)
            return reports().length > 1 ? reportAccounts(reports(), now()) : []
          }
          return <Show when={accounts().length > 0} fallback={
            <box flexDirection="row" width="100%" gap={1}>
              <text fg={ctx.theme.text} width={6} flexShrink={0}>{provider.name}</text>
              <Windows list={reportWindows(reports()[0], now())} />
            </box>
          }>
            <box>
              <text fg={ctx.theme.text}><b>{provider.name}</b></text>
              <For each={accounts()}>{(account) => <box flexDirection="row" width="100%" gap={1}>
                <text flexShrink={0} fg={account.current ? ctx.theme.success : ctx.theme.textMuted}>•</text>
                <text fg={ctx.theme.text} flexShrink={1} wrapMode="none">{account.label}</text>
                <Windows list={account.windows} />
              </box>}</For>
            </box>
          </Show>
        }}</For>
      </box>
    }, 600))
  },
} satisfies PasodePlugin
