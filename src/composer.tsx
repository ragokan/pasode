// OpenCode 2.0.26's composer (routes/session/composer/*, MIT): ↓ under the prompt opens Subagents/Shell tabs.
// Shells are Paseo's own terminals in the session directory (Paseo-native; nothing runs locally).
import { TextAttributes, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { dialog } from "./dialog"
import { agents, daemon, findModel, openSubagentTimeline } from "./paseo"
import { agentId, navigate, setSubagent, showError } from "./state"
import { SplitBorder } from "./session"
import { createTerminal, handleTerminalKey, paneFocused, TerminalPane, terminals, type Terminal } from "./terminal"
import { theme } from "./theme"

export { registerTerminalCommands, terminals, useTerminalFeed } from "./terminal"

export type SubagentEntry = { key: string; kind: "agent" | "native"; id: string; agent: string; title: string; status: string; model?: string }

type Native = Awaited<ReturnType<typeof daemon.listProviderSubagents>>["subagents"][number]
const [native, setNative] = createStore<{ parentId?: string; list: Native[] }>({ list: [] })

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
    .map((agent): SubagentEntry => {
      const model = agent.model ?? agent.runtimeInfo?.model
      return {
        key: `agent:${agent.id}`,
        kind: "agent",
        id: agent.id,
        agent: "Agent",
        title: agent.title || "Untitled",
        status: agent.status,
        // Provider-native subagents carry no model in Paseo, so only child agents get "Sonnet 5.5 · xhigh".
        model: [findModel(agent.provider, model)?.label ?? model, agent.thinkingOptionId ?? agent.effectiveThinkingOptionId].filter(Boolean).join(" · "),
      }
    })
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

/** The open session's provider subagents, live: a one-shot list for the initial state, then the daemon's pushed upserts/removals. */
export function useSubagentFeed() {
  createEffect(() => {
    const parent = agentId()
    if (parent) void refreshSubagents(parent)
  })
  const feed = daemon.observeEvents(["agent.provider_subagents.update"])
  feed.subscribe({
    // Updates aren't replayed across a reconnect, so list again once the feed is back.
    snapshot() {
      const parent = agentId()
      if (parent) void refreshSubagents(parent)
    },
    update(message) {
      if (message.type !== "agent.provider_subagents.update") return
      const update = message.payload
      if (update.kind === "timeline") return // an open subagent view follows its own (openSubagentTimeline)
      if ((update.kind === "upsert" ? update.subagent.parentAgentId : update.parentAgentId) !== native.parentId) return
      const { list } = native
      const next =
        update.kind === "remove"
          ? list.filter((item) => item.id !== update.subagentId)
          : list.some((item) => item.id === update.subagent.id)
            ? list.map((item) => (item.id === update.subagent.id ? update.subagent : item))
            : [...list, update.subagent]
      setNative("list", reconcile(next, { key: "id" }))
    },
  })
  onCleanup(() => void feed.release().catch(() => {}))
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
const [armed, setArmed] = createSignal<string>()
/** The picker closed and its choices (tab, row, finished filter, armed key, provider subagents) as at launch; for tests, which share one process. */
export function resetComposer() {
  setOpen(false)
  setTab("subagents")
  setSelected(0)
  setActiveOnly(true)
  setArmed(undefined)
  setNative({ parentId: undefined, list: [] })
}

/** Open, or the terminal pane holds the keyboard: the prompt gives way to either. */
export const composerOpen = () => open() || paneFocused()

const visibleSubagents = () => subagents().filter((entry) => (activeOnly() ? entry.status === "running" : entry.status !== "running"))
const visibleShells = () => terminals()
// Paseo titles a `!` terminal with its whole wrapper script; its name is the command.
const shellLabel = (shell: Terminal) => (shell.name.startsWith("!") ? shell.name : shell.title || shell.name)
const killTerminal = (id: string) => void daemon.killTerminal(id).catch(showError)

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
  if (handleTerminalKey(key)) return true
  if (!open()) return false
  // archive/detach need their key twice in a row, like the session list's ctrl+d.
  const was = armed()
  setArmed(undefined)
  const confirm = (action: string) => was === action || (setArmed(action), false)
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
  } else if (key.ctrl && (key.name === "k" || key.name === "u") && tab() === "subagents") {
    const entry = visibleSubagents()[selected()]
    const archive = key.name === "k"
    if (entry?.kind === "agent" && confirm(`${archive ? "archive" : "detach"}:${entry.id}`)) {
      if (archive) void daemon.archiveAgent(entry.id).catch(showError)
      // Like the Paseo app, a detached child continues as its own session, opened right away.
      else void daemon.detachAgent(entry.id).then(() => (closeComposer(), navigate(entry.id)), showError)
    }
  } else return false
  return true
}

export function Composer() {
  let scroll: ScrollBoxRenderable | undefined
  const items = createMemo(() =>
    tab() === "subagents"
      ? visibleSubagents().map((entry) => {
          const action = [...(["archive", "detach"] as const)].find((name) => armed() === `${name}:${entry.id}`)
          return {
            key: entry.key,
            text: action ? `Press ctrl+${action === "archive" ? "k" : "u"} again to ${action}` : `${entry.agent}: ${entry.title}`,
            meta: action ? "" : [entry.model, entry.status === "running" && "Running"].filter(Boolean).join(" · "),
            armed: !!action,
          }
        })
      : visibleShells().map((shell) => ({ key: shell.id, text: shellLabel(shell), meta: shell.activity?.state ?? "", armed: false })),
  )
  createEffect(() => {
    if (selected() >= items().length) setSelected(Math.max(0, items().length - 1))
    const target = scroll?.getChildren()[selected()]
    if (scroll && target && (target.y - scroll.y >= scroll.height || target.y < scroll.y)) scroll.scrollChildIntoView(target.id)
  })
  const hints = () =>
    tab() === "subagents"
      ? [
          ["enter", "open"],
          ["ctrl+d", "interrupt"],
          ["ctrl+a", activeOnly() ? "finished" : "running"],
          ...(visibleSubagents()[selected()]?.kind === "agent" ? [["ctrl+k", "archive"], ["ctrl+u", "detach"]] : []),
        ]
      : items().length
        ? [["enter", "output"], ["ctrl+d", "kill"]]
        : []
  return (
    <>
    <TerminalPane />
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
                    backgroundColor={item.armed ? theme.error : index() === selected() ? theme.backgroundElement : undefined}
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
    </>
  )
}

/** `!command`: runs in a new Paseo terminal in `cwd` and opens its output; the model never sees it. */
export async function runShell(cwd: string, text: string) {
  const command = text.trim()
  if (!command) throw new Error("Type a command after !")
  try {
    // Paseo drops a terminal, output included, as soon as its process exits, so the command waits on Enter at the end.
    const terminal = await createTerminal(cwd, `! ${command.split("\n")[0]}`, { command: "sh", args: ["-c", `(\n${command}\n)\ncode=$?\nprintf '\\n[exit %s]\\n' "$code"\nread -r _`] })
    openShellOutput(terminal.id)
  } catch (error) {
    showError(error)
    throw error
  }
}

/** OpenCode's DialogShellOutput: the Paseo terminal's text (ANSI stripped, scrollable), re-read whenever the terminal's stream shows activity. */
export function openShellOutput(id: string) {
  dialog.replace(() => <ShellOutput id={id} />, "large")
}

function ShellOutput(props: { id: string }) {
  const terminal = () => terminals().find((item) => item.id === props.id)
  const [lines, setLines] = createSignal<string[]>([])
  let latest = 0
  const load = () => {
    const request = ++latest
    daemon
      .captureTerminal(props.id, { stripAnsi: true })
      .then((capture) => request === latest && setLines(capture.lines))
      .catch(() => {})
  }
  // A burst of output is one capture, not one per chunk.
  let refresh: ReturnType<typeof setTimeout> | undefined
  const schedule = () => (refresh ??= setTimeout(() => ((refresh = undefined), load()), 100))
  void load()
  const stream = daemon.observeTerminal(props.id, schedule, { restore: { mode: "live" } })
  // Attached (or back after a reconnect): whatever printed before that wasn't streamed to us.
  stream.subscribe({ snapshot: schedule, update: (message) => message.type === "terminal_stream_exit" && schedule() })
  onCleanup(() => {
    clearTimeout(refresh)
    void stream.release().catch(() => {})
  })
  const status = () => (terminal() ? (lines().findLast((line) => /^\[exit \d+\]$/.test(line.trim()))?.slice(1, -1) ?? terminal()!.activity?.state ?? "running") : "closed")
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
          {terminal() ? shellLabel(terminal()!) : "Shell"}
        </text>
        <text fg={theme.textMuted}>esc</text>
      </box>
      <scrollbox height={20} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
        <text fg={theme.textMuted}>{lines().join("\n").trimEnd() || "(no output)"}</text>
      </scrollbox>
      <text fg={theme.textMuted}>
        {status()} · <span style={{ fg: theme.text }}>ctrl+d</span> kill
      </text>
    </box>
  )
}
