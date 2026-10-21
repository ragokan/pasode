import { startLocalDaemon } from "./local-daemon"
import { agents, connect, disconnect, sessionTitle } from "./paseo"

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
