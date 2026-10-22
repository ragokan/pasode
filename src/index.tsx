import pkg from "../package.json"
import { parseArgs } from "./args"
import { startLocalDaemon } from "./local-daemon"
import { agents, connect, disconnect, sessionTitle } from "./paseo"

const usage = `pasode [-s | --session] [agent-id]   open the TUI (agent-id: a Paseo agent ID or its \`paseo ls\` prefix)
pasode update                        install the latest release over this binary
pasode -v | --version                print the version
pasode -h | --help                   print this help

OpenCode-style terminal client for a running Paseo daemon.
New sessions start in the current directory.

env: PASEO_URL (default ws://127.0.0.1:6767/ws), PASEO_PASSWORD`

// `pasode -s <id>` like `opencode -s`; a bare id (or `paseo ls` prefix) works too. Anything else is a usage error.
const cli = parseArgs(process.argv.slice(2))
if (cli.run === "usage") {
  console.error(usage)
  process.exit(1)
}
if (cli.run === "help") {
  console.log(usage)
  process.exit(0)
}
if (cli.run === "version") {
  console.log(pkg.version)
  process.exit(0)
}
if (cli.run === "update") {
  const { updateCommand } = await import("./update")
  try {
    console.log(await updateCommand())
    process.exit(0)
  } catch (error) {
    console.error(`pasode update failed: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
const arg = cli.run === "tui" ? cli.session : undefined

// Connect while the app's modules load (they take longer than the handshake), and apply the theme before the first frame.
// Loading starts one loop turn after connect() does: it is ~0.7 s of synchronous work, and the socket must open first.
const daemonReady = startLocalDaemon()
const connected = daemonReady.then(connect)
const loaded = daemonReady.then(() => Bun.sleep(0)).then(() =>
  Promise.all([
    import("@opentui/solid"),
    import("./app"),
    import("./logo"),
    import("./renderer"),
    import("./state"),
    import("./update"),
    Promise.all([import("./state"), import("./theme"), import("./themes")]).then(([{ prefs }, { applyTheme }, { loadTheme }]) =>
      loadTheme(prefs.theme, prefs.themeMode).then(applyTheme, () => {}),
    ),
  ]),
)
loaded.catch(() => {}) // a failed start is reported through `connected`; an import error still throws at the await below
try {
  await connected
} catch (error) {
  console.error(`Could not reach the Paseo daemon: ${error instanceof Error ? error.message : error}`)
  console.error("Is it running? Check with `paseo status`.")
  process.exit(1)
}
// `update.installed` is a live binding the /update command flips; keep the namespaces.
const [{ render }, { App }, { sessionEpilogue }, { rendererOptions }, state, update] = await loaded

await render(() => <App initialAgentId={arg} />, {
  ...rendererOptions,
  useMouse: state.prefs.mouse,
  onDestroy: () => {
    const id = state.agentId()
    if (id && !update.installed) process.stdout.write(sessionEpilogue({ title: (agents[id] && sessionTitle(agents[id])) || "Untitled", id }) + "\n")
    void disconnect().finally(() => (update.installed ? update.relaunch(id) : process.exit(0)))
  },
})
void update.checkForUpdate()
