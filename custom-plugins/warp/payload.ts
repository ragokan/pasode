// Provenance: ~/coding/ocode/plugins/warp/src/{payload,notify,title,constants}.ts (Warp MIT); Kaku spinner from title.ts.
import path from "node:path"

export const PLUGIN_VERSION = "0.1.8"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

// ocode's title.ts: a full-width Warp tab shows about 32-34 characters and cuts longer titles at the start.
export const WARP_TITLE_MAX = 27

export function formatTitle(title: string | null | undefined, indicator = "", max = 40) {
  return indicator + truncate(clean(title || "Paseo"), max)
}

type Env = Readonly<Record<string, string | undefined>>
export const inWarp = (env: Env) => ["warpterminal", "warp"].includes(env.TERM_PROGRAM?.toLowerCase() ?? "")
export const inKaku = (env: Env) => env.TERM_PROGRAM === "Kaku"

// ocode's Kaku title spinner: a clockwise snake in braille rows 2-3. Each title change costs Kaku CPU, so 250 ms.
export const SPINNER = "⠲⠰⠴⠤⠦⠆⠖⠒"
export const SPINNER_MS = 250

const PLUGIN_MAX_PROTOCOL_VERSION = 1

// ocode's negotiateProtocolVersion: speak the older of Warp's advertised protocol version and ours.
export function negotiateProtocolVersion(env: Env) {
  const warpVersion = parseInt(env.WARP_CLI_AGENT_PROTOCOL_VERSION || "1", 10)
  return Number.isNaN(warpVersion) ? PLUGIN_MAX_PROTOCOL_VERSION : Math.min(warpVersion, PLUGIN_MAX_PROTOCOL_VERSION)
}

/**
 * Warp's rich CLI-agent protocol. Warp only accepts it for a pane it tracks as a known agent, so paseo-tui
 * reports itself as "opencode" and Warp maps the `pasode` command to OpenCode via
 * agents.third_party.cli_agent_toolbar_enabled_commands in ~/.warp/settings.toml.
 */
export function richSequence(event: string, agent: { id: string; cwd: string }, extra: Record<string, unknown>, env: Env) {
  if (!inWarp(env) || !env.WARP_CLI_AGENT_PROTOCOL_VERSION) return
  const body = JSON.stringify({
    v: negotiateProtocolVersion(env),
    agent: "opencode",
    event,
    session_id: agent.id,
    cwd: agent.cwd,
    project: agent.cwd ? path.basename(agent.cwd) : "",
    ...extra,
  })
  return `\x1b]777;notify;warp://cli-agent;${clean(body)}\x07`
}

/** Cuts by grapheme, so an emoji (surrogate pair or ZWJ sequence) is never split. */
export function truncate(text: string, max: number) {
  const graphemes = Array.from(new Intl.Segmenter().segment(text), (part) => part.segment)
  return graphemes.length > max ? graphemes.slice(0, max - 1).join("") + "…" : text
}
