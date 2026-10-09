// OpenCode 2.0.26's composer (routes/session/composer/*, MIT): ↓ under the prompt opens Subagents/Shell tabs.
// Shells are Paseo's own terminals in the session directory (Paseo-native; nothing runs locally).
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { dialog } from "./dialog"
import { agents, daemon, openSubagentTimeline } from "./paseo"
import { current } from "./state"
import { SplitBorder } from "./session"
import { agentId, navigate, setSubagent, showError } from "./state"
import { theme } from "./theme"

export type SubagentEntry = { key: string; kind: "agent" | "native"; id: string; agent: string; title: string; status: string }

const [native, setNative] = createStore<{ parentId?: string; list: Awaited<ReturnType<typeof daemon.listProviderSubagents>>["subagents"] }>({ list: [] })

export async function refreshSubagents(parentId: string) {
  const result = await daemon.listProviderSubagents(parentId).catch(() => undefined)
  if (!result || agentId() !== parentId) return
  setNative("parentId", parentId)
  setNative("list", reconcile(result.subagents))
}

/** Paseo child agents (labelled with their parent) plus provider-native subagents (Claude Task / Codex child threads). */
export const subagents = createMemo<SubagentEntry[]>(() => {
  const parent = agentId()
  if (!parent) return []
  const children = Object.values(agents)
    .filter((agent) => agent.labels?.["paseo.parent-agent-id"] === parent)
    .map((agent): SubagentEntry => ({ key: `agent:${agent.id}`, kind: "agent", id: agent.id, agent: "Agent", title: agent.title || "Untitled", status: agent.status }))
  const provided = native.parentId === parent ? native.list : []
  return [
    ...children,
    ...provided.map((item): SubagentEntry => ({
      key: `native:${item.id}`,
      kind: "native",
      id: item.id,
      // OpenCode's "Agent: title": the subagent type (Claude's Task type, e.g. general-purpose), then its task.
      agent: (item.title || "Subagent").replace(/^\w/, (letter) => letter.toUpperCase()),
      title: item.description || item.subtitle || item.id,
      status: item.status,
    })),
  ]
})

export const runningSubagents = () => subagents().filter((entry) => entry.status === "running").length

type Terminal = Awaited<ReturnType<typeof daemon.listTerminals>>["terminals"][number]
const [terminalStore, setTerminalStore] = createStore<{ cwd?: string; list: Terminal[] }>({ list: [] })
/** Paseo terminals open in the current session's directory. */
export const terminals = () => (terminalStore.cwd === current()?.cwd ? terminalStore.list : [])

async function refreshTerminals(cwd: string) {
  const result = await daemon.listTerminals(cwd).catch(() => undefined)
  if (!result || current()?.cwd !== cwd) return
  setTerminalStore("cwd", cwd)
  setTerminalStore("list", reconcile(result.terminals))
}

/** Poll Paseo terminals for the session directory (cheap list RPC). */
export function useTerminalPolling() {
  createEffect(() => {
    const cwd = current()?.cwd
    if (!cwd) return
    void refreshTerminals(cwd)
    const timer = setInterval(() => void refreshTerminals(cwd), 3000)
    onCleanup(() => clearInterval(timer))
  })
}

/** Poll provider subagents while the session runs (Paseo has no cheap push for them). */
export function useSubagentPolling(running: () => boolean) {
  createEffect(() => {
    const parent = agentId()
    if (!parent) return
    void refreshSubagents(parent)
    if (!running()) return
    const timer = setInterval(() => void refreshSubagents(parent), 3000)
    onCleanup(() => clearInterval(timer))
  })
}

export async function openSubagent(entry: SubagentEntry) {
  const parent = agentId()
  if (entry.kind === "agent") return navigate(entry.id)
  if (!parent) return
  setSubagent({ parentId: parent, id: entry.id, title: entry.title })
  await openSubagentTimeline(parent, entry.id).catch(showError)
}

type Tab = "subagents" | "shell"
const [open, setOpen] = createSignal(false)
const [tab, setTab] = createSignal<Tab>("subagents")
const [selected, setSelected] = createSignal(0)
const [activeOnly, setActiveOnly] = createSignal(true)
export const composerOpen = open

const visibleSubagents = () => subagents().filter((entry) => (activeOnly() ? entry.status === "running" : entry.status !== "running"))
const visibleShells = () => terminals()
const killTerminal = (id: string) => void daemon.killTerminal(id).then(() => current() && refreshTerminals(current()!.cwd), showError)

/** session.child.first: toggle the picker, opening on whichever tab has something live. */
export function toggleComposer() {
  if (open()) return closeComposer()
  setTab(visibleSubagents().length || !visibleShells().length ? "subagents" : "shell")
  setSelected(0)
  setOpen(true)
  const parent = agentId()
  if (parent) void refreshSubagents(parent)
}
export const closeComposer = () => setOpen(false)

/** Keys while the composer is open (OpenCode's "composer" keymap mode). */
export function handleComposerKey(key: KeyEvent) {
  if (!open()) return false
  const count = tab() === "subagents" ? visibleSubagents().length : visibleShells().length
  if (key.name === "escape" || (key.ctrl && key.name === "c")) closeComposer()
  else if (key.name === "left" || key.name === "right") {
    setTab((current) => (current === "subagents" ? "shell" : "subagents"))
    setSelected(0)
  } else if (key.name === "up") selected() === 0 ? closeComposer() : setSelected((index) => index - 1)
  else if (key.name === "down") count && setSelected((index) => (index + 1) % count)
  else if (key.name === "return") {
    if (tab() === "subagents") {
      const entry = visibleSubagents()[selected()]
      if (entry) closeComposer(), void openSubagent(entry)
    } else {
      const shell = visibleShells()[selected()]
      if (shell) openShellOutput(shell.id)
    }
  } else if (key.ctrl && key.name === "d") {
    if (tab() === "shell") {
      const shell = visibleShells()[selected()]
      if (shell) killTerminal(shell.id)
    } else {
      const entry = visibleSubagents()[selected()]
      if (entry?.kind === "agent") void daemon.cancelAgent(entry.id).catch(showError)
    }
  } else if (key.ctrl && key.name === "a" && tab() === "subagents") {
    setActiveOnly((value) => !value)
    setSelected(0)
  } else return false
  return true
}

export function Composer() {
  let scroll: ScrollBoxRenderable | undefined
  const items = createMemo(() =>
    tab() === "subagents"
      ? visibleSubagents().map((entry) => ({ key: entry.key, text: `${entry.agent}: ${entry.title}`, meta: entry.status === "running" ? "Running" : "" }))
      : visibleShells().map((shell) => ({ key: shell.id, text: shell.title || shell.name, meta: shell.activity?.state ?? "" })),
  )
  createEffect(() => {
    if (selected() >= items().length) setSelected(Math.max(0, items().length - 1))
    const target = scroll?.getChildren()[selected()]
    if (scroll && target && (target.y - scroll.y >= scroll.height || target.y < scroll.y)) scroll.scrollChildIntoView(target.id)
  })
  const hints = () =>
    tab() === "subagents"
      ? [["enter", "open"], ["ctrl+d", "interrupt"], ["ctrl+a", activeOnly() ? "finished" : "running"]]
      : items().length
        ? [["enter", "output"], ["ctrl+d", "kill"]]
        : []
  return (
    <Show when={open()}>
      <box border={["left"]} customBorderChars={SplitBorder} borderColor={theme.border} backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <box gap={1}>
          <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
            <box flexDirection="row" gap={2}>
              <For each={[["subagents", "Subagents"], ["shell", "Shell"]] as const}>
                {([id, label]) => (
                  <text fg={tab() === id ? theme.text : theme.textMuted} attributes={tab() === id ? TextAttributes.BOLD : undefined} onMouseUp={() => (setTab(id), setSelected(0))}>
                    {label}
                  </text>
                )}
              </For>
            </box>
            <text fg={theme.textMuted} onMouseUp={closeComposer}>
              esc
            </text>
          </box>
          <scrollbox scrollbarOptions={{ visible: false }} maxHeight={5} ref={(r: ScrollBoxRenderable) => (scroll = r)}>
            <Show
              when={items().length}
              fallback={<text fg={theme.textMuted}> {tab() === "shell" ? "No shells in this directory" : activeOnly() ? "No running subagents" : "No finished subagents"}</text>}
            >
              <For each={items()}>
                {(item, index) => (
                  <box
                    id={`composer-${item.key}`}
                    flexDirection="row"
                    justifyContent="space-between"
                    gap={1}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={index() === selected() ? theme.backgroundElement : undefined}
                    onMouseMove={() => setSelected(index())}
                    onMouseUp={() => {
                      setSelected(index())
                      handleComposerKey({ name: "return" } as KeyEvent)
                    }}
                  >
                    <text fg={index() === selected() ? theme.text : theme.textMuted} attributes={index() === selected() ? TextAttributes.BOLD : undefined} wrapMode="none" truncate>
                      {item.text}
                    </text>
                    <text fg={theme.textMuted} flexShrink={0}>
                      {item.meta}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </scrollbox>
          <Show when={hints().length}>
            <box flexDirection="row" gap={2} paddingLeft={1}>
              <For each={hints()}>
                {([shortcut, label]) => (
                  <text fg={theme.text}>
                    {shortcut} <span style={{ fg: theme.textMuted }}>{label}</span>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      </box>
    </Show>
  )
}

/** OpenCode's DialogShellOutput, reading the Paseo terminal's screen (ANSI stripped), refreshed every second. */
export function openShellOutput(id: string) {
  dialog.replace(() => <ShellOutput id={id} />, "large")
}

function ShellOutput(props: { id: string }) {
  const terminal = () => terminals().find((item) => item.id === props.id)
  const [lines, setLines] = createSignal<string[]>([])
  const load = () =>
    daemon
      .captureTerminal(props.id, { stripAnsi: true })
      .then((capture) => setLines(capture.lines))
      .catch(() => {})
  void load()
  const timer = setInterval(load, 1000)
  onCleanup(() => clearInterval(timer))
  useKeyboard((key) => {
    if (key.defaultPrevented || !(key.ctrl && key.name === "d")) return
    key.preventDefault()
    killTerminal(props.id)
    dialog.clear()
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
          {terminal()?.title || terminal()?.name || "Shell"}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <scrollbox height={20} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
        <text fg={theme.textMuted}>{lines().join("\n").trimEnd() || "(no output)"}</text>
      </scrollbox>
      <text fg={theme.textMuted}>
        {terminal() ? (terminal()!.activity?.state ?? "running") : "closed"} · <span style={{ fg: theme.text }}>ctrl+d</span> kill
      </text>
    </box>
  )
}
