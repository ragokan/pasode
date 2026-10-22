// Plugin host, shaped after OpenCode's TUI plugins: `export default { id, setup(ctx) }`,
// with ctx.ui.slot(...) for sidebar/home sections, ctx.commands.register(...), dialogs and toasts.
// Plugins are listed in ~/.config/pasode/cli.json; this repo's own live in custom-plugins/.
import type { CliRenderer } from "@opentui/core"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRoot, For, getOwner, onCleanup, runWithOwner, type JSX, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import { registerCommands, runCommand, type Command } from "./commands"
import { pluginSpecs } from "./config"
import { dialog, dialogs, DialogSelect, truncate } from "./dialog"
import * as mcp from "./mcp"
import * as paseo from "./paseo"
import { Spinner, SplitBorder } from "./session"
import * as state from "./state"
import { applyTheme, syntax, theme } from "./theme"

export type SlotName = "sidebar_title" | "sidebar_content" | "sidebar_footer" | "home_bottom" | "session_header"
export type SlotProps = { agent?: paseo.PaseoAgent }

type SlotEntry = { id: number; plugin: string; order: number; render: (props: SlotProps) => JSX.Element }
const [slots, setSlots] = createStore<Partial<Record<SlotName, SlotEntry[]>>>({})
let nextSlotId = 0

/** Renders plugin entries for a slot by order; `single` keeps only the highest-order entry (OpenCode's single_winner). */
export function Slot(props: SlotProps & { name: SlotName; single?: boolean; children?: JSX.Element }) {
  const entries = () => {
    const list = (slots[props.name] ?? []).toSorted((a, b) => a.order - b.order)
    return props.single ? list.slice(-1) : list
  }
  return (
    <>
      {entries().length === 0 && props.children}
      {/* Getter keeps `agent` reactive inside plugin renders when the session changes. */}
      <For each={entries()}>{(entry) => entry.render({ get agent() { return props.agent } })}</For>
    </>
  )
}

export type PasodeContext = {
  id: string
  options: Record<string, unknown>
  /** Paseo client, live stores and the current-session helpers. */
  paseo: typeof paseo & Pick<typeof state, "agentId" | "current" | "navigate">
  state: typeof state
  theme: typeof theme
  syntax: typeof syntax
  applyTheme: typeof applyTheme
  renderer: CliRenderer
  ui: {
    slot(name: SlotName, render: (props: SlotProps) => JSX.Element, order?: number): () => void
    toast(message: string, variant?: state.ToastVariant, title?: string): void
    dialog: typeof dialogs & { replace: typeof dialog.replace; clear: typeof dialog.clear }
    components: { DialogSelect: typeof DialogSelect; Spinner: typeof Spinner; SplitBorder: typeof SplitBorder; truncate: typeof truncate }
  }
  commands: { register(list: Command[]): () => void; run: typeof runCommand }
  /** Provider MCP config (Claude .claude.json / Codex config.toml); Paseo itself has no MCP API. */
  mcp: typeof mcp
}

export type PasodePlugin = { id: string; setup(ctx: PasodeContext): void | Promise<void> }

function context(plugin: string, options: Record<string, unknown>, renderer: CliRenderer): PasodeContext {
  return {
    id: plugin,
    options,
    paseo: { ...paseo, agentId: state.agentId, current: state.current, navigate: state.navigate },
    state,
    theme,
    syntax,
    applyTheme,
    renderer,
    ui: {
      slot(name, render, order = 0) {
        const entry = { id: nextSlotId++, plugin, order, render }
        setSlots(name, (list = []) => [...list, entry])
        return () => setSlots(name, (list = []) => list.filter((item) => item.id !== entry.id))
      },
      toast: state.notify,
      dialog: { ...dialogs, replace: dialog.replace, clear: dialog.clear },
      components: { DialogSelect, Spinner, SplitBorder, truncate },
    },
    commands: { register: registerCommands, run: runCommand },
    mcp,
  }
}

/** A directory resolves through package.json ("exports"/"module"/"main") or index/tui .tsx/.ts. */
export function resolveEntry(target: string) {
  if (!existsSync(target)) throw new Error(`not found: ${target}`)
  if (!statSync(target).isDirectory()) return target
  const pkg = path.join(target, "package.json")
  if (existsSync(pkg)) {
    const json = JSON.parse(readFileSync(pkg, "utf8"))
    const entry = json.pasode ?? (typeof json.exports === "string" ? json.exports : json.exports?.["."]) ?? json.module ?? json.main
    if (typeof entry === "string") return path.join(target, entry)
  }
  for (const name of ["index.tsx", "index.ts", "tui.tsx", "tui.ts"]) if (existsSync(path.join(target, name))) return path.join(target, name)
  throw new Error(`no entry file in ${target}`)
}

export const [loadedPlugins, setLoadedPlugins] = createStore<{ id: string; spec: string; error?: string }[]>([])

/** Call from inside the app (needs the reactive owner) after ensureRuntimePluginSupport() ran in the launcher. */
export async function loadPlugins(renderer: CliRenderer, features: PasodePlugin[] = []) {
  const owner = getOwner() as Owner
  // A root isn't owned by the scope it's created in, so dispose each with the app: their slots go away with it.
  const roots: (() => void)[] = []
  runWithOwner(owner, () => onCleanup(() => roots.forEach((dispose) => dispose())))
  const mount = <T,>(setup: () => T) => runWithOwner(owner, () => createRoot((dispose) => (roots.push(dispose), setup())))
  // Built-in features first; /status lists only the plugins from cli.json.
  for (const feature of features) mount(() => feature.setup(context(feature.id, {}, renderer)))
  for (const spec of pluginSpecs()) {
    try {
      if (spec.error) throw new Error(spec.error)
      const module = await import(pathToFileURL(resolveEntry(spec.path)).href)
      const exported = module.default ?? module
      // A module may export one plugin or several (like ocode's consolidated entry).
      for (const plugin of (Array.isArray(exported) ? exported : [exported]) as PasodePlugin[]) {
        if (typeof plugin?.setup !== "function") throw new Error("default export has no setup(ctx)")
        await mount(() => plugin.setup(context(plugin.id ?? spec.spec, spec.options, renderer)))
        setLoadedPlugins((list) => [...list, { id: plugin.id ?? spec.spec, spec: spec.spec }])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLoadedPlugins((list) => [...list, { id: spec.spec, spec: spec.spec, error: message }])
      state.notify(`Plugin ${spec.spec}: ${message}`, "error")
    }
  }
}
