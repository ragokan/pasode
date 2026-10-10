// Provenance: OpenCode MIT sidebar/footer.tsx and routes/session/sidebar.tsx single-winner footer.
import { createSignal, onCleanup } from "solid-js"
import type { PasodePlugin } from "@pasode/host"

export default {
  id: "sidebar-footer",
  setup(ctx) {
    onCleanup(ctx.ui.slot("sidebar_footer", () => {
      const [status, setStatus] = createSignal(ctx.paseo.daemon.getConnectionState().status)
      const [version, setVersion] = createSignal(ctx.paseo.daemon.getLastServerInfoMessage()?.version)
      onCleanup(ctx.paseo.daemon.subscribeConnectionStatus((state) => {
        setStatus(state.status)
        setVersion(ctx.paseo.daemon.getLastServerInfoMessage()?.version)
      }))
      onCleanup(ctx.paseo.daemon.on((event) => {
        if (event.type === "status" && event.payload.status === "server_info") {
          setVersion(ctx.paseo.daemon.getLastServerInfoMessage()?.version)
        }
      }))
      return <text fg={ctx.theme.textMuted}>
        <span style={{ fg: status() === "connected" ? ctx.theme.success : ctx.theme.textMuted }}>•</span> <span style={{ fg: ctx.theme.text }}><b>Paseo</b></span> {version() ?? "—"} {status()}
      </text>
    }, 100))
  },
} satisfies PasodePlugin
