import { createSignal } from "solid-js"
import { config } from "./config"
import { formatBinding, parseBinding } from "./keys"

export type Command = {
  /** Stable id; `keybinds.<id>` in cli.json overrides the default keybind. */
  id: string
  title: string
  category: string
  description?: string
  keybind?: string
  slash?: string
  /** Hidden from the palette (still reachable by key/slash). */
  hidden?: boolean
  enabled?: () => boolean
  run: (args?: string) => void
}

export const leader = config.leader ?? "ctrl+x"
const [registry, setRegistry] = createSignal<Command[]>([])
export const commands = registry

/** Register commands; later registrations with the same id win. Returns an unregister function. */
export function registerCommands(list: Command[]) {
  setRegistry((all) => [...all.filter((command) => !list.some((item) => item.id === command.id)), ...list])
  return () => setRegistry((all) => all.filter((command) => !list.includes(command)))
}

export const isEnabled = (command: Command) => command.enabled?.() ?? true
export const keybindOf = (command: Command) => config.keybinds?.[command.id] ?? command.keybind
export const keybindLabel = (command: Command) => formatBinding(keybindOf(command), leader)

export function runCommand(id: string, args?: string) {
  const command = registry().find((item) => item.id === id)
  if (command && isEnabled(command)) command.run(args)
}

export const commandBindings = () =>
  registry()
    .filter(isEnabled)
    .map((command) => ({ id: command.id, sequences: parseBinding(keybindOf(command), leader) }))
