// Provenance: ~/coding/ocode/plugins/warp/src/{payload,notify,title,constants}.ts (Warp MIT).
import path from "node:path"

export const PLUGIN_VERSION = "0.1.8"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

export function formatTitle(title: string | null | undefined, indicator = "") {
  const label = clean(title || "Paseo")
  return indicator + (label.length > 40 ? label.slice(0, 37) + "…" : label)
}

type Env = Readonly<Record<string, string | undefined>>
export const inWarp = (env: Env) => ["warpterminal", "warp"].includes(env.TERM_PROGRAM?.toLowerCase() ?? "")

/**
 * Warp's rich CLI-agent protocol. Warp only accepts it for a pane it tracks as a known agent, so paseo-tui
 * reports itself as "opencode" and Warp maps the `pasode` command to OpenCode via
 * agents.third_party.cli_agent_toolbar_enabled_commands in ~/.warp/settings.toml.
 */
export function richSequence(event: string, agent: { id: string; cwd: string }, extra: Record<string, unknown>, env: Env) {
  if (!inWarp(env) || !env.WARP_CLI_AGENT_PROTOCOL_VERSION) return
  const body = JSON.stringify({
    v: 1,
    agent: "opencode",
    event,
    session_id: agent.id,
    cwd: agent.cwd,
    project: agent.cwd ? path.basename(agent.cwd) : "",
    ...extra,
  })
  return `\x1b]777;notify;warp://cli-agent;${clean(body)}\x07`
}

export const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1) + "…" : text)
