// Provenance: OpenCode MIT packages/tui/src/feature-plugins/sidebar/mcp.tsx.
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import type { PasodePlugin } from "../../plugin"

export default {
  id: "sidebar-mcp",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_content", (props) => {
      const [open, setOpen] = createSignal(true)
      const [servers] = createResource(
        () => props.agent && { provider: props.agent.provider, cwd: props.agent.cwd, revision: ctx.paseo.mcpRevision() },
        (source) => ctx.mcp.listMcpServers(source.provider, source.cwd),
      )
      return <Show when={!servers.error && (servers() ?? []).length > 0} fallback={
        <Show when={servers.error}><box>
          <text fg={ctx.theme.text}><b>MCP</b></text>
          <text fg={ctx.theme.textMuted}>Unable to read provider config</text>
        </box></Show>
      }>
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => (servers() ?? []).length > 2 && setOpen((value) => !value)}>
            <Show when={(servers() ?? []).length > 2}><text fg={ctx.theme.text}>{open() ? "▼" : "▶"}</text></Show>
            <text fg={ctx.theme.text}><b>MCP</b><Show when={!open()}>
              <span style={{ fg: ctx.theme.textMuted }}> ({(servers() ?? []).filter((server) => server.enabled).length} enabled)</span>
            </Show></text>
          </box>
          <Show when={(servers() ?? []).length <= 2 || open()}>
            <For each={servers() ?? []}>{(server) => <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={server.enabled ? ctx.theme.success : ctx.theme.textMuted}>•</text>
              <text fg={ctx.theme.text} wrapMode="word">{server.name} <span style={{ fg: ctx.theme.textMuted }}>{server.enabled ? "Enabled" : "Disabled"}</span></text>
            </box>}</For>
          </Show>
        </box>
      </Show>
    }, 200))
  },
} satisfies PasodePlugin
