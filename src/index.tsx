import { render } from "@opentui/solid"
import { App } from "./app"
import { connect, disconnect } from "./paseo"

const usage = `paseo-tui [agent-id]

OpenCode-style terminal client for a running Paseo daemon.
New sessions start in the current directory.

env: PASEO_URL (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD`

const arg = process.argv[2]
if (arg === "-h" || arg === "--help") {
  console.log(usage)
  process.exit(0)
}

try {
  await connect()
} catch (error) {
  console.error(`Could not reach the Paseo daemon: ${error instanceof Error ? error.message : error}`)
  console.error("Is it running? Check with `paseo status`.")
  process.exit(1)
}

await render(() => <App initialAgentId={arg} />, {
  exitOnCtrlC: false,
  onDestroy: () => void disconnect().finally(() => process.exit(0)),
})
