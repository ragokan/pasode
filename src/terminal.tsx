// Paseo terminals in the session directory: the live list, and an interactive pane that renders the daemon's raw
// stream in OpenTUI's embedded terminal (after OpenCode's component/terminal-pane.tsx, MIT; Paseo-native: the shell runs on the daemon).
import { EmbeddedTerminalRenderable, TextAttributes, type KeyEvent, type RGBA } from "@opentui/core"
import { extend, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { commands, keybindLabel, leader, registerCommands } from "./commands"
import { dialog } from "./dialog"
import { matchStroke, parseBinding } from "./keys"
import { daemon } from "./paseo"
import { SplitBorder } from "./session"
import { current, showError } from "./state"
import { theme } from "./theme"

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    embeddedTerminal: typeof EmbeddedTerminalRenderable
  }
}
extend({ embeddedTerminal: EmbeddedTerminalRenderable })

export type Terminal = Awaited<ReturnType<typeof daemon.listTerminals>>["terminals"][number]
const [store, setStore] = createStore<{ cwd?: string; list: Terminal[] }>({ list: [] })
/** Paseo terminals open in the current session's directory. */
export const terminals = () => (store.cwd === current()?.cwd ? store.list : [])

const [paneId, setPaneId] = createSignal<string>()
const [paneFocused, setPaneFocused] = createSignal(false)
export { paneFocused }

/** The daemon pushes the directory's terminal list on every change; the pane belongs to the directory too. */
export function useTerminalFeed() {
  createEffect(() => {
    const cwd = current()?.cwd
    if (!cwd) return
    const feed = daemon.observeTerminals({ cwd })
    const apply = ({ terminals }: { terminals: Terminal[] }) => {
      setStore("cwd", cwd)
      setStore("list", reconcile(terminals))
    }
    feed.subscribe({ snapshot: apply, update: (message) => message.type === "terminals_changed" && apply(message.payload) })
    onCleanup(() => {
      setPaneId(undefined)
      void feed.release().catch(() => {})
    })
  })
}

/** A new terminal in `cwd`. Paseo scopes terminals to a workspace; a directory with no session yet needs one opened. */
export async function createTerminal(cwd: string, name: string, run?: { command: string; args: string[] }) {
  const agent = current()
  const workspaceId = agent?.cwd === cwd && agent.workspaceId ? agent.workspaceId : await openWorkspace(cwd)
  const { terminal, error } = await daemon.createTerminal(cwd, name, undefined, { workspaceId, ...run })
  if (!terminal) throw new Error(error ?? "Couldn't open a terminal")
  return terminal
}

async function openWorkspace(cwd: string) {
  const { workspace, error } = await daemon.openProject(cwd)
  if (!workspace) throw new Error(error ?? `Can't open ${cwd}`)
  return workspace.id
}

const closePane = () => setPaneId(undefined)
let term: EmbeddedTerminalRenderable | undefined
let opening = false

/** terminal.toggle: show and focus the newest shell (a new one if there is none); focused → release to the prompt; shown → focus. */
async function toggleTerminal() {
  const agent = current()
  if (!agent || opening) return
  if (paneFocused()) return term?.blur()
  if (paneId()) return term?.focus()
  opening = true
  try {
    // `!` commands hold their terminal open to read the output; they aren't shells to type into.
    const shell = terminals().findLast((item) => !item.name.startsWith("!")) ?? (await createTerminal(agent.cwd, "pasode"))
    if (current() === agent) setPaneId(shell.id)
  } catch (error) {
    showError(error)
  } finally {
    opening = false
  }
}

export function registerTerminalCommands() {
  return registerCommands([
    { id: "terminal.toggle", title: "Toggle terminal", category: "Session", keybind: "<leader>o", slash: "terminal", enabled: () => !!current(), run: () => void toggleTerminal() },
    { id: "terminal.close", title: "Close terminal pane", category: "Session", enabled: () => !!paneId(), run: closePane },
  ])
}

const leaderStroke = parseBinding(leader)[0]?.[0]

/** While the pane has focus every key goes to the shell, except the leader so `<leader>o` still reaches the keymap. */
export function handleTerminalKey(key: KeyEvent) {
  if (!paneFocused() || !term || (leaderStroke && matchStroke(leaderStroke, key))) return false
  term.handleKeyPress(key)
  return true
}

const hex = (color: RGBA) => `#${color.toInts().slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("")}`

export function TerminalPane() {
  return <Show when={paneId()} keyed>{(id) => <Pane id={id} />}</Show>
}

function Pane(props: { id: string }) {
  const dimensions = useTerminalDimensions()
  const height = () => Math.max(6, Math.min(16, Math.floor(dimensions().height / 2.5)))
  let stream: ReturnType<typeof daemon.observeTerminal> | undefined
  const title = () => terminals().find((item) => item.id === props.id)
  const toggle = () => {
    const command = commands().find((item) => item.id === "terminal.toggle")
    return command && keybindLabel(command)
  }

  // Our size wins on the PTY (as in the Paseo app), so the stream's screen and our emulator agree.
  const claim = (cols: number, rows: number) => daemon.sendTerminalInput(props.id, { type: "resize", rows, cols, intent: "claim" })
  function resized(cols: number, rows: number) {
    claim(cols, rows)
    if (stream) return
    stream = daemon.observeTerminal(props.id, (event) => event.type !== "snapshot" && term?.write(event.data), {
      restore: { mode: "visible-snapshot", scrollbackLines: 200, size: { rows, cols } },
    })
    stream.subscribe({ snapshot() {}, update: (message) => message.type === "terminal_stream_exit" && closePane() })
    void stream.ready.then((payload) => payload.error && closePane(), () => {})
  }

  // Default colors follow the theme; the cells' own colors come from the shell.
  createEffect(() => term?.write(`\x1b]10;${hex(theme.text)}\x1b\\`))
  // Something else needs the keyboard: a dialog, or a permission request on the session.
  createEffect(() => (dialog.isOpen || current()?.pendingPermissions?.length) && paneFocused() && term?.blur())
  onMount(() => term?.focus())
  onCleanup(() => {
    void stream?.release().catch(() => {})
    setPaneFocused(false)
    term = undefined
  })

  return (
    <box border={["left"]} customBorderChars={SplitBorder} borderColor={paneFocused() ? theme.primary : theme.border} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1} height={height()} flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
          {title()?.title || title()?.name || "Terminal"}
        </text>
        <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
          {paneFocused() ? `${toggle() ?? "/terminal"} release focus` : `click or ${toggle() ?? "/terminal"} to focus`}
        </text>
      </box>
      <embeddedTerminal
        ref={(value: EmbeddedTerminalRenderable) => {
          term = value
          value.on("focused", () => setPaneFocused(true))
          value.on("blurred", () => setPaneFocused(false))
        }}
        width="100%"
        height={height() - 1}
        flexShrink={0}
        transparentBackground
        onData={(data, source) => source === "input" && daemon.sendTerminalInput(props.id, { type: "input", data: Buffer.from(data).toString() })}
        onTerminalResize={resized}
      />
    </box>
  )
}
