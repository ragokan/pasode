import { TextAttributes } from "@opentui/core"
import { Slot } from "../plugin"
import { sessionTitle, type PaseoAgent } from "../paseo"
import { prefs } from "../state"
import { theme } from "../theme"
import context from "./context/tui"
import files from "./files/tui"
import footer from "./footer/tui"
import mcp from "./mcp/tui"
import metrics from "./metrics/tui"
import todo from "./todo/tui"

/** Built-in sections, registered through the plugin slot API like OpenCode's feature plugins so plugins can interleave by order. */
export const sidebarFeatures = [context, mcp, todo, files, metrics, footer]

// Same frame as OpenCode's routes/session/sidebar.tsx; sections come from sidebarFeatures and plugins.
export function Sidebar(props: { agent: PaseoAgent }) {
  return (
    <box width={prefs.sidebarWidth} flexShrink={0} height="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} backgroundColor={theme.backgroundPanel}>
      <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
        <box flexShrink={0} gap={1} paddingRight={1}>
          <Slot name="sidebar_title" single agent={props.agent}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {sessionTitle(props.agent) || "Untitled"}
            </text>
          </Slot>
          <Slot name="sidebar_content" agent={props.agent} />
        </box>
      </scrollbox>
      <box flexShrink={0} gap={1} paddingTop={1}>
        <Slot name="sidebar_footer" single agent={props.agent}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Paseo</b>
          </text>
        </Slot>
      </box>
    </box>
  )
}
