// Small session commands: slash aliases, import, session ID, child sessions, jump to the last prompt.
import * as actions from "./actions"
import { dialog } from "./dialog"
import { runCommand, type Command } from "./commands"
import { timeline } from "./paseo"
import { current } from "./state"
import { ImportList } from "./session-list"

export function sessionCommands(app: { scrollToRow: (index: number) => void }): Command[] {
  const openImport = () => dialog.replace(() => ImportList(), "large")
  const alias = (id: string, slash: string, title: string, target: string): Command => ({ id, title, category: "Session", slash, hidden: true, run: () => runCommand(target) })
  return [
    { id: "session.import", title: "Import a session started outside Paseo", category: "Session", slash: "resume", run: openImport },
    { id: "session.import.alias", title: "Import a session started outside Paseo", category: "Session", slash: "import", hidden: true, run: openImport },
    { id: "session.copy.id", title: "Copy session ID", category: "Session", slash: "copy-id", enabled: () => !!current(), run: () => actions.copyId() },
    { id: "session.child.next", title: "Next child session", category: "Session", keybind: "<leader>right", enabled: () => !!current(), run: () => actions.cycleChild(1) },
    { id: "session.child.previous", title: "Previous child session", category: "Session", keybind: "<leader>left", enabled: () => !!current(), run: () => actions.cycleChild(-1) },
    {
      id: "messages.last_user",
      title: "Jump to last user message",
      category: "Navigation",
      enabled: () => !!current(),
      run: () => {
        const index = timeline.rows.findLastIndex((row) => row.type === "user_message")
        if (index >= 0) app.scrollToRow(index)
      },
    },
    alias("session.list.continue", "continue", "Switch session", "session.list"),
    alias("app.exit.quit", "quit", "Exit", "app.exit"),
    alias("variant.list.effort", "effort", "Switch model variant", "variant.list"),
  ]
}
