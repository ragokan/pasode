// /status host admin: daemon config summary, provider diagnostics on demand, and the actions that restart the host
// (each behind a confirm). Paseo-native: nothing here touches the machine pasode runs on.
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createResource, Show } from "solid-js"
import { dialog, DialogAlert, dialogs } from "../dialog"
import { api, daemon, PROVIDERS, providerName } from "../paseo"
import { Spinner } from "../session"
import { notify, showError } from "../state"
import { theme } from "../theme"

type DaemonConfig = Awaited<ReturnType<typeof api.config.get>>["config"]

/** Flags and counts only: provider entries carry keys and env, so just their names show. */
export function configSummary(config: DaemonConfig | undefined) {
  if (!config) return "—"
  const on = (value?: boolean) => (value ? "on" : "off")
  return [
    `MCP ${on(config.mcp?.enabled)}${config.mcp?.injectIntoAgents ? " (injected)" : ""}`,
    `plugins ${on(config.pluginsEnabled)}`,
    `relay ${on(config.relay?.enabled)}`,
    `browser tools ${on(config.browserTools?.enabled)}`,
    `${config.agentProfiles?.length ?? 0} profiles`,
    `providers ${Object.keys(config.providers ?? {}).join(", ") || "—"}`,
  ].join(" · ")
}

/** The status text with host admin keys; resolves when closed, like dialogs.alert. */
export function statusDialog(message: string) {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
      dialog.clear()
    }
    dialog.replace(() => <DialogStatus message={message} onDone={finish} />, "large", finish)
  })
}

function DialogStatus(props: { message: string; onDone: () => void }) {
  const actions = { d: diagnostics, r: restart, u: update }
  useKeyboard((key) => {
    const run = actions[key.name as keyof typeof actions]
    if (key.defaultPrevented || !run || key.ctrl || key.meta) return
    key.preventDefault()
    void run()
  })
  return <DialogAlert title="Status" message={`${props.message}\n\n[d] provider diagnostics · [r] restart daemon · [u] update daemon`} onDone={props.onDone} />
}

async function diagnostics() {
  const provider = await dialogs.select({ title: "Provider diagnostics", options: PROVIDERS.map((id) => ({ title: providerName(id), value: id })) })
  if (provider) dialog.replace(() => <Diagnostic provider={provider} />, "large")
}

function Diagnostic(props: { provider: string }) {
  // Can take a while: the daemon runs the provider's CLI checks.
  const [text] = createResource(() => daemon.getProviderDiagnostic(props.provider).then((result) => result.diagnostic))
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {providerName(props.provider)} diagnostics
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <Show when={!text.loading} fallback={<Spinner>Running diagnostics…</Spinner>}>
        <scrollbox height={Math.min(22, (text() ?? "").split("\n").length || 1)} scrollbarOptions={{ visible: false }}>
          <text fg={text.error ? theme.error : theme.textMuted}>{text.error ? String(text.error.message ?? text.error) : text()}</text>
        </scrollbox>
      </Show>
    </box>
  )
}

async function restart() {
  const ok = await dialogs.confirm("Restart daemon", "Restarts the Paseo daemon: running sessions are interrupted, and every client (the apps, this terminal) reconnects.", "Restart")
  if (ok) await daemon.restartServer("pasode /status").then(() => notify("Daemon restarting; pasode reconnects on its own", "warning"), showError)
}

/** Paseo's updateDaemon is not a check: it runs `npm install -g @getpaseo/cli@latest` on the host, then restarts the daemon. */
async function update() {
  const version = daemon.getLastServerInfoMessage()?.version
  const ok = await dialogs.confirm(
    "Update daemon",
    `Installs the latest Paseo release on the daemon's host (now ${version ?? "unknown"}), then restarts the daemon: running sessions are interrupted.`,
    "Update",
  )
  if (!ok) return
  notify("Updating the daemon…")
  const result = await daemon.updateDaemon().catch(showError)
  if (!result) return
  if (!result.success) return showError(result.error ?? "Daemon update failed")
  notify(`Daemon updated ${result.previousVersion ?? "?"} → ${result.newVersion ?? "latest"}; it is restarting`, "success")
}
