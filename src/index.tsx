import { render } from "@opentui/solid"
import { App } from "./app"
import { startLocalDaemon } from "./local-daemon"
import { sessionEpilogue } from "./logo"
import { agents, connect, disconnect, sessionTitle } from "./paseo"
import { rendererOptions } from "./renderer"
import { agentId, prefs } from "./state"

const usage = `paseo-tui [-s] [agent-id]

OpenCode-style terminal client for a running Paseo daemon.
New sessions start in the current directory.

env: PASEO_URL (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD`

// `pasode -s <id>` like `opencode -s`; a bare id (or `paseo ls` prefix) works too.
const arg = ["-s", "--session"].includes(process.argv[2] ?? "") ? process.argv[3] : process.argv[2]
if (arg === "-h" || arg === "--help") {
  console.log(usage)
  process.exit(0)
}

try {
  await startLocalDaemon()
  await connect()
} catch (error) {
  console.error(`Could not reach the Paseo daemon: ${error instanceof Error ? error.message : error}`)
  console.error("Is it running? Check with `paseo status`.")
  process.exit(1)
}

await render(() => <App initialAgentId={arg} />, {
  ...rendererOptions,
  useMouse: prefs.mouse,
  onDestroy: () => {
    const id = agentId()
    if (id) process.stdout.write(sessionEpilogue({ title: (agents[id] && sessionTitle(agents[id])) || "Untitled", id }) + "\n")
    void disconnect().finally(() => process.exit(0))
  },
})
