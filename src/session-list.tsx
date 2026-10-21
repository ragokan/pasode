// The session switcher (ctrl+x l): live sessions with pins, the daemon's whole history (archived included), and the
// importer for sessions started outside Paseo. The Paseo app's Sessions screen and import sheet do the same.
import path from "node:path"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import * as actions from "./actions"
import { dialog, DialogSelect, type SelectOption } from "./dialog"
import { active, agents, api, daemon, ownWorkspace, PROVIDERS, sessionTitle, setAgents, waiting, workspacePins, type PaseoAgent } from "./paseo"
import { Spinner } from "./session"
import { agentId, navigate, notify, showError } from "./state"
import { theme } from "./theme"
import { dayCategory } from "./timeline"

/** A session the daemon returned that the live list doesn't hold yet (restored, imported) must open right away. */
const adopt = (agent: PaseoAgent) => agents[agent.id] ?? setAgents(agent.id, agent)

export function SessionList() {
  const [history, setHistory] = createSignal(false)
  return (
    <Show when={history()} fallback={<LiveSessions onHistory={() => setHistory(true)} />}>
      <HistorySessions onBack={() => setHistory(false)} />
    </Show>
  )
}

function LiveSessions(props: { onHistory: () => void }) {
  const [confirm, setConfirm] = createSignal<string>()
  const [focused, setFocused] = createSignal<string>()
  const pinned = (id?: string) => {
    const workspace = id && agents[id]?.workspaceId
    return !!workspace && !!workspacePins[workspace]
  }
  const options = createMemo(() => {
    // Only agents in a pinned workspace need the ownWorkspace check.
    const pins = new Set(Object.keys(workspacePins).filter((id) => workspacePins[id]))
    return Object.values(agents)
      .map((agent) => ({ agent, pin: !!agent.workspaceId && pins.has(agent.workspaceId) && !!ownWorkspace(agent), rank: active(agent) ? 2 : waiting(agent) ? 1 : 0 }))
      .toSorted((a, b) => Number(b.pin) - Number(a.pin) || b.rank - a.rank || Date.parse(b.agent.updatedAt) - Date.parse(a.agent.updatedAt))
      .map(
        ({ agent, pin, rank }): SelectOption<string> => ({
          title: confirm() === agent.id ? "Press ctrl+d again to archive" : sessionTitle(agent) || "Untitled",
          bg: confirm() === agent.id ? theme.error : undefined,
          value: agent.id,
          category: pin ? "Pinned" : rank === 2 ? "Running" : rank === 1 ? "Waiting" : dayCategory(agent.updatedAt),
          footer: `${agent.provider} · ${path.basename(agent.cwd)}`,
          gutter:
            agent.status === "running"
              ? () => <Spinner color={theme.primary} />
              : agent.pendingPermissions?.length
                ? () => <text fg={theme.warning}>△</text>
                : agent.status === "error"
                  ? () => <text fg={theme.error}>✕</text>
                  : rank === 1
                    ? () => <Spinner />
                    : undefined,
        }),
      )
  })
  return (
    <DialogSelect
      title="Sessions"
      emptyText="No sessions on the daemon yet"
      options={options()}
      current={agentId()}
      onMove={(option) => (setConfirm(undefined), setFocused(option.value))}
      onSelect={(option) => {
        dialog.clear()
        navigate(option.value)
      }}
      actions={[
        {
          label: "ctrl+r",
          title: "rename",
          match: (key) => key.ctrl && key.name === "r",
          run: (option) => void actions.rename(option.value),
        },
        {
          label: "ctrl+d",
          title: "archive",
          match: (key) => key.ctrl && key.name === "d",
          run: (option) => {
            if (confirm() !== option.value) return setConfirm(option.value)
            setConfirm(undefined)
            api.agents
              .ref(option.value)
              .archive()
              .then(() => agentId() === option.value && navigate(undefined))
              .catch(showError)
          },
        },
        {
          label: "ctrl+f",
          get title() {
            return pinned(focused()) ? "unpin" : "pin"
          },
          match: (key) => key.ctrl && key.name === "f",
          run: (option) => void actions.pin(option.value),
        },
        { label: "tab", title: "history", match: (key) => key.name === "tab", run: props.onHistory },
      ]}
    />
  )
}

/** Debounced daemon search: `load` runs at once, then once the typing pauses; replies of superseded calls are dropped. */
function searched<T>(fetch: (query: string) => Promise<T>, apply: (result: T) => void) {
  let token = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => (token++, clearTimeout(timer)))
  const load = (query: string) => {
    const mine = ++token
    fetch(query).then((result) => mine === token && apply(result), (error) => mine === token && showError(error))
  }
  load("")
  return (query: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => load(query.trim()), 200)
  }
}

function HistorySessions(props: { onBack: () => void }) {
  const [entries, setEntries] = createSignal<PaseoAgent[]>()
  // shortcut: the newest 100 matches, no paging; narrow with the search.
  const filter = searched(
    (search) => daemon.fetchAgentHistory({ ...(search ? { search } : {}), sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 100 } }),
    (page) => setEntries(page.entries.map((entry) => entry.agent)),
  )
  async function open(agent: PaseoAgent) {
    dialog.clear()
    // Paseo's own "Unarchive" is refreshAgent: it clears the archive flag and reloads the session from its history.
    if (agent.archivedAt) {
      try {
        await daemon.refreshAgent(agent.id)
      } catch (error) {
        return showError(error)
      }
      adopt({ ...agent, archivedAt: null })
      notify("Restored from the archive", "success")
    }
    navigate(agent.id)
  }
  return (
    <DialogSelect
      title="Session history"
      placeholder="Search all sessions, archived too"
      emptyText={entries() ? "No sessions match" : "Loading sessions…"}
      options={(entries() ?? []).map(
        (agent): SelectOption<PaseoAgent> => ({
          title: agent.title || "Untitled",
          value: agent,
          category: dayCategory(agent.updatedAt),
          footer: `${agent.provider} · ${path.basename(agent.cwd)}${agent.archivedAt ? " · archived" : ""}`,
        }),
      )}
      onFilter={filter}
      onSelect={(option) => void open(option.value)}
      actions={[{ label: "tab", title: "sessions", match: (key) => key.name === "tab", run: props.onBack }]}
    />
  )
}

/** /resume: recent Claude and Codex sessions started outside Paseo, imported on select. */
export function ImportList() {
  const [entries, setEntries] = createSignal<Awaited<ReturnType<typeof daemon.fetchRecentProviderSessions>>>()
  const filter = searched(
    (query) => daemon.fetchRecentProviderSessions({ providers: [...PROVIDERS], limit: 50, ...(query ? { query } : {}) }),
    (result) => {
      setEntries(result)
      if (result.providerErrors?.length) notify(result.providerErrors.map((error) => `${error.provider}: ${error.message}`).join("\n"), "warning")
    },
  )
  async function importSession(entry: NonNullable<ReturnType<typeof entries>>["entries"][number]) {
    dialog.clear()
    notify(`Importing "${entry.title || entry.firstPromptPreview || "Untitled"}"…`)
    try {
      const agent = await daemon.importAgent({ providerId: entry.providerId, providerHandleId: entry.providerHandleId, cwd: entry.cwd })
      adopt(agent)
      navigate(agent.id)
    } catch (error) {
      showError(error)
    }
  }
  return (
    <DialogSelect
      title="Import a session"
      placeholder="Search Claude and Codex sessions"
      emptyText={
        entries()
          ? `No sessions started outside Paseo${entries()!.filteredAlreadyImportedCount ? ` (${entries()!.filteredAlreadyImportedCount} already imported)` : ""}`
          : "Loading sessions…"
      }
      options={(entries()?.entries ?? []).map((entry) => ({
        title: entry.title || entry.firstPromptPreview || "Untitled",
        value: entry,
        category: dayCategory(entry.lastActivityAt),
        footer: `${entry.providerLabel} · ${path.basename(entry.cwd)}`,
      }))}
      onFilter={filter}
      onSelect={(option) => void importSession(option.value)}
    />
  )
}
