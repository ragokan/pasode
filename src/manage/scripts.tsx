// Workspace scripts (paseo.json): lifecycle, health, port and proxy URL of the open session's workspace, start/stop live,
// plus the workspace setup run. Paseo-native; the scripts run in Paseo terminals (output opens like /shells).
import { createMemo, createSignal, onCleanup } from "solid-js"
import { openShellOutput } from "../composer"
import { dialog, DialogSelect } from "../dialog"
import { api, daemon } from "../paseo"
import { current, notify, showError } from "../state"
import { theme } from "../theme"

type Script = NonNullable<Awaited<ReturnType<typeof daemon.listWorkspaceScripts>>["scripts"]>[number]
type Setup = Awaited<ReturnType<typeof daemon.fetchWorkspaceSetupStatus>>["snapshot"]

/** What a script's row shows: "running · healthy" / "exited 1" / "stopped", plus its URL or port. */
export function scriptRow(script: Script) {
  const running = script.lifecycle === "running"
  const state = running ? ["running", script.health].filter(Boolean).join(" · ") : script.exitCode ? `exited ${script.exitCode}` : "stopped"
  const url = script.localProxyUrl ?? script.proxyUrl ?? script.publicProxyUrl
  const where = running ? (url ?? (script.port ? `:${script.port}` : undefined)) : undefined
  return {
    state,
    description: [script.type === "service" && "service", where].filter(Boolean).join(" · ") || undefined,
    tone: !running ? (script.exitCode ? "error" : "muted") : script.health === "unhealthy" ? "warning" : "success",
  } as const
}

/** "setup running 1/3" for the dialog title; nothing before the workspace has run a setup. */
export function setupLabel(setup: Setup | undefined) {
  if (!setup) return undefined
  if (setup.status !== "running") return `setup ${setup.status === "completed" ? "done" : setup.status}`
  const commands = setup.detail.commands
  return `setup running ${commands.filter((command) => command.status !== "running").length}/${commands.length}`
}

export function openScripts() {
  const workspaceId = current()?.workspaceId
  if (!workspaceId) return notify("Open a session first: scripts belong to its workspace", "warning")
  dialog.replace(() => <Scripts workspaceId={workspaceId} />, "large")
}

const SETUP = "\0setup"

function Scripts(props: { workspaceId: string }) {
  const id = props.workspaceId
  const [scripts, setScripts] = createSignal<Script[]>([])
  const [setup, setSetup] = createSignal<Setup>(null)
  const [loaded, setLoaded] = createSignal(false)
  const load = () =>
    Promise.all([daemon.listWorkspaceScripts(id), daemon.fetchWorkspaceSetupStatus(id)])
      .then(([list, status]) => {
        if (list.error) throw new Error(list.error)
        setScripts(list.scripts ?? [])
        setSetup(status.snapshot)
        setLoaded(true)
      })
      .catch(showError)
  void load()
  // Live status and setup progress; the snapshot also arrives after a reconnect, so changes made while offline show up.
  const events = api.observeEvents(["script_status_update", "workspace_setup_progress"])
  const stop = events.subscribe({
    snapshot: () => void load(),
    update(message) {
      if (message.type === "script_status_update" && message.payload.workspaceId === id) setScripts(message.payload.scripts)
      if (message.type === "workspace_setup_progress" && message.payload.workspaceId === id) setSetup(message.payload)
    },
  })
  onCleanup(() => {
    stop()
    void events.release().catch(() => {})
  })

  const tones = { error: theme.error, muted: theme.textMuted, warning: theme.warning, success: theme.success }
  const options = createMemo(() => [
    { title: "Run workspace setup", value: SETUP, category: "Workspace", description: setupLabel(setup()) },
    ...scripts().map((script) => {
      const row = scriptRow(script)
      return {
        title: script.scriptName,
        value: script.scriptName,
        category: "Scripts",
        description: row.description,
        footer: row.state,
        gutter: () => <text fg={tones[row.tone]}>{row.tone === "error" ? "✕" : row.tone === "muted" ? "○" : "●"}</text>,
      }
    }),
  ])
  const start = (name: string) =>
    daemon
      .startWorkspaceScript(id, name)
      .then((result) => (result.error ? showError(result.error) : notify(`Started ${name}`, "success")))
      .catch(showError)
  const runSetup = () =>
    daemon
      .runWorkspaceSetup(id)
      .then((result) => (result.started ? notify("Running workspace setup…") : showError(result.error ?? "Workspace setup did not start")))
      .catch(showError)
  // Enter starts a stopped script and opens a running one's terminal output.
  const select = (name: string) => {
    if (name === SETUP) return void runSetup()
    const script = scripts().find((item) => item.scriptName === name)
    if (script?.lifecycle === "running" && script.terminalId) return openShellOutput(script.terminalId)
    void start(name)
  }
  return (
    <DialogSelect
      title={loaded() && !scripts().length ? "Scripts · none in this workspace's paseo.json" : "Scripts"}
      options={options()}
      search={false}
      onSelect={(option) => select(option.value)}
      actions={[
        {
          title: "stop",
          label: "x",
          match: (key) => key.name === "x" && !key.ctrl && !key.meta,
          run: (option) =>
            option.value !== SETUP &&
            void daemon
              .stopWorkspaceScript(id, option.value)
              .then((result) => (result.error ? showError(result.error) : notify(`Stopped ${option.value}`)))
              .catch(showError),
        },
      ]}
    />
  )
}
