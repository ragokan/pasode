import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** ~/.config/pasode/cli.json — a subset of OpenCode's cli.json shape. JSONC allowed. */
export type PasodeConfig = {
  theme?: { name?: string; mode?: "dark" | "light" }
  leader?: string
  keybinds?: Record<string, string>
  /** Plugin paths (absolute, ~, or relative to the config file); `[path, options]` passes options to setup. */
  plugins?: (string | [string, Record<string, unknown>])[]
  /** OpenCode 2.0.26's `session` options, plus sidebarWidth/details/timestamps/diffs/permissions. */
  session?: {
    sidebar?: "auto" | "show" | "hide"
    sidebarWidth?: number
    scrollbar?: boolean
    image_preview?: boolean
    new_location?: "launch" | "inherit"
    thinking?: "show" | "hide"
    grouping?: "auto" | "none"
    verbosity?: "low" | "medium" | "high"
    tps?: boolean
    markdown?: "source" | "rendered"
    details?: boolean
    timestamps?: boolean
    diffs?: "auto" | "unified" | "split"
    /** "bypass" (default): new sessions start in Claude's Bypass / Codex's Full Access mode. */
    permissions?: "bypass" | "prompt"
  }
  attention?: { notifications?: boolean }
}

const home = os.homedir()
export const configDir = process.env.PASODE_CONFIG_DIR ?? path.join(home, ".config", "pasode")
export const configPath = path.join(configDir, "cli.json")
const statePath = path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "pasode", "kv.json")

export const expandHome = (value: string) => value.replace(/^~(?=$|\/)/, home)

function readJsonc(file: string): any {
  try {
    return Bun.JSONC.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error(`${file}: ${error instanceof Error ? error.message : error}`)
  }
}

export const config: PasodeConfig = readJsonc(configPath)

export function pluginSpecs() {
  return (config.plugins ?? []).map((entry) => {
    const [spec, options] = Array.isArray(entry) ? entry : [entry, {}]
    const resolved = expandHome(spec)
    return { spec, path: path.isAbsolute(resolved) ? resolved : path.resolve(configDir, resolved), options }
  })
}

/** Last runtime choices (theme, toggles), like OpenCode's kv.json; config values are the defaults. */
const kv: Record<string, unknown> = readJsonc(statePath)

export function kvGet<T>(key: string, fallback: T): T {
  return (kv[key] as T | undefined) ?? fallback
}

export function kvSet(key: string, value: unknown) {
  kv[key] = value
  try {
    mkdirSync(path.dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(kv, null, 2))
  } catch {} // preferences are best-effort
}
