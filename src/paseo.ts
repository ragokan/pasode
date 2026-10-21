import { createPaseoApi, type PaseoAgent, type PaseoAgentStream, type PaseoProviderUsageResult, type PaseoWorkspace } from "@getpaseo/client"
import { DaemonClient, supportsUsageReports } from "@getpaseo/client/internal/daemon-client"
import type { UsageReportEntry } from "@getpaseo/protocol/messages"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { batch, createComputed, createMemo, createRoot, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { applyTimelineItem, dropStaleCompactions, type AgentTimelineItem } from "./timeline"

export type { PaseoAgent }

export const PROVIDERS = ["claude", "codex"] as const

/** PASEO_URL, else the daemon's configured TCP listen address (what `paseo status` reports), else the default port. */
function daemonUrl() {
  if (process.env.PASEO_URL) return process.env.PASEO_URL
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")
  try {
    const listen = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).daemon?.listen
    if (typeof listen === "string" && /^[\w.-]+:\d+$/.test(listen)) return `ws://${listen}/ws`
  } catch {}
  return "ws://127.0.0.1:6767/ws"
}

// The internal DaemonClient is what the public SDK wraps; we need it for cancel/mode/model.
export const daemon = new DaemonClient({
  url: daemonUrl(),
  password: process.env.PASEO_PASSWORD,
  clientId: `paseo-tui-${crypto.randomUUID()}`,
  clientType: "cli",
})
export const api = createPaseoApi(daemon)

export async function connect() {
  await daemon.connect()
  void loadCatalog()
  void watchWorkspaces().catch(() => {})
  const list = await api.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 200 }, subscribe: {} })
  setAgents(reconcile(Object.fromEntries(list.entries.map(({ agent }) => [agent.id, agent]))))
  list.subscription.subscribe({
    snapshot: ({ entries }) => setAgents(reconcile(Object.fromEntries(entries.map(({ agent }) => [agent.id, agent])))),
    update(message) {
      if (message.type !== "agent_update") return
      const update = message.payload
      if (update.kind === "upsert" && !update.agent.archivedAt) setAgents(update.agent.id, reconcile(update.agent))
      else {
        const id = update.kind === "upsert" ? update.agent.id : update.agentId
        setAgents(produce((all) => delete all[id]))
      }
    },
  })
}

export async function disconnect() {
  await api.dispose().catch(() => {})
  await daemon.close().catch(() => {})
}

/** Every non-archived Paseo agent, live. */
export const [agents, setAgents] = createStore<Record<string, PaseoAgent>>({})

/** Workspace id → title, live. */
export const [workspaceTitles, setWorkspaceTitles] = createStore<Record<string, string | null>>({})
/** Workspace id → when it was pinned (null: not pinned), live; synced with the Paseo app. */
export const [workspacePins, setWorkspacePins] = createStore<Record<string, string | null>>({})

async function watchWorkspaces() {
  const by = (entries: PaseoWorkspace[], value: (workspace: PaseoWorkspace) => string | null | undefined) =>
    reconcile(Object.fromEntries(entries.map((workspace) => [workspace.id, value(workspace) ?? null])))
  const title = (workspace: PaseoWorkspace) => workspace.title
  const pinned = (workspace: PaseoWorkspace) => workspace.pinnedAt
  const list = await api.workspaces.list({ filter: { includeBackground: true }, page: { limit: 200 }, subscribe: {} })
  setWorkspaceTitles(by(list.entries, title))
  setWorkspacePins(by(list.entries, pinned))
  list.subscription.subscribe({
    snapshot: ({ entries }) => (setWorkspaceTitles(by(entries, title)), setWorkspacePins(by(entries, pinned))),
    update(message) {
      if (message.type !== "workspace_update") return
      const update = message.payload
      if (update.kind === "upsert") {
        setWorkspaceTitles(update.workspace.id, title(update.workspace) ?? null)
        setWorkspacePins(update.workspace.id, pinned(update.workspace) ?? null)
      } else {
        setWorkspaceTitles(produce((all) => delete all[update.id]))
        setWorkspacePins(produce((all) => delete all[update.id]))
      }
    },
  })
}

/** Whether `agent` is a subagent of `ancestorId`, directly or through other subagents. */
export const spawnedBy = (agent: PaseoAgent | undefined, ancestorId: string): boolean => {
  const parent = agent?.labels?.["paseo.parent-agent-id"]
  return !!parent && (parent === ancestorId || spawnedBy(agents[parent], ancestorId))
}

export const active = (agent: PaseoAgent) => agent.status === "running" || !!agent.pendingPermissions?.length

// Module-level memos: one pass over the agents per change, instead of a scan per agent per read (O(n²) for the session list).
const workspaceAgents = createRoot(() =>
  createMemo(() => {
    const result = new Map<string, PaseoAgent[]>()
    for (const agent of Object.values(agents)) {
      if (!agent.workspaceId) continue
      const peers = result.get(agent.workspaceId)
      if (peers) peers.push(agent)
      else result.set(agent.workspaceId, [agent])
    }
    return result
  }),
)
// Every agent with an active subagent below it, directly or through other subagents. A store, so a reader of one
// agent's flag isn't woken when another's changes.
const [ancestorsOfActive, setAncestorsOfActive] = createStore<Record<string, true>>({})
createRoot(() =>
  createComputed(() => {
    const result: Record<string, true> = {}
    for (const agent of Object.values(agents)) {
      if (!active(agent)) continue
      for (let parent = agent.labels?.["paseo.parent-agent-id"]; parent && !result[parent]; parent = agents[parent]?.labels?.["paseo.parent-agent-id"]) result[parent] = true
    }
    setAncestorsOfActive(reconcile(result))
  }),
)

/** Idle, but a subagent it spawned is still working, so the session isn't done. */
export const waiting = (agent: PaseoAgent) => !active(agent) && !!ancestorsOfActive[agent.id]

/** The agent's own workspace, if no other live agent shares it; subagents it spawned there don't count. */
export const ownWorkspace = (agent: PaseoAgent) =>
  agent.workspaceId && !workspaceAgents().get(agent.workspaceId)?.some((other) => other.id !== agent.id && !spawnedBy(other, agent.id))
    ? agent.workspaceId
    : undefined

/**
 * Paseo auto-names the session's workspace after the first message (the agent keeps the prompt's first line), so a
 * session alone in its workspace shows the workspace title, like the Paseo app; shared workspaces keep agent titles.
 */
export const sessionTitle = (agent: PaseoAgent) => {
  const workspace = ownWorkspace(agent)
  return (workspace && workspaceTitles[workspace]) || agent.title
}

type Cursor = NonNullable<Awaited<ReturnType<ReturnType<typeof api.agents.ref>["timeline"]["refetch"]>>["startCursor"]>

/** Timing marks for the sidebar's Speed/TTFT metrics (src/sidebar/metrics). */
export type Mark =
  | { kind: "item"; type: string; at: number; callId?: string; status?: string }
  | { kind: "turn_started"; at: number }
  | { kind: "turn_completed"; at: number; outputTokens?: number }

/** Rendered timeline of the open session: rows, each row's start time, timing marks for metrics, and paging state. */
export const [timeline, setTimeline] = createStore<{
  agentId?: string
  rows: AgentTimelineItem[]
  /** Bumped by every change to `rows` except a text delta merged into the last message, so readers of the whole timeline subscribe to this instead of to every row. */
  revision: number
  times: number[]
  marks: Mark[]
  loading: boolean
  hasOlder: boolean
  startCursor?: Cursor
}>({ rows: [], revision: 0, times: [], marks: [], loading: false, hasOlder: false })

const PAGE = 300

/** Bumped on every open, so a reply for an earlier open (even of the same session) is dropped. */
let opened = 0
/** Bumped when a refetch rewrites the rows in place (same array), so an older page fetched before it is dropped. */
let refetched = 0
let older: Promise<boolean> | undefined

/** Prepends the previous page of history (the newest PAGE entries load on open). Concurrent calls share one request. */
export function loadOlder() {
  const open = opened
  return (older ??= fetchOlder().finally(() => {
    if (open === opened) older = undefined
  }))
}

async function fetchOlder() {
  const open = opened
  const replaced = refetched
  const { agentId, startCursor, hasOlder, rows } = timeline
  if (!agentId || !startCursor || !hasOlder) return false
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "before", cursor: startCursor, limit: PAGE, projection: "projected" })
  if (open !== opened || timeline.rows !== rows || refetched !== replaced) return false
  setTimeline(
    produce((draft) => {
      const entries = dropStaleCompactions(page.entries)
      draft.rows.unshift(...entries.map((entry) => entry.item))
      draft.times.unshift(...entries.map((entry) => Date.parse(entry.timestamp)))
      draft.marks.unshift(...entries.map((entry) => itemMark(entry.item, Date.parse(entry.timestamp))))
      draft.hasOlder = page.hasOlder && !!page.startCursor
      draft.startCursor = page.startCursor ?? undefined
      draft.revision++
    }),
  )
  return page.entries.length > 0
}

function itemMark(item: AgentTimelineItem, at: number): Mark {
  return item.type === "tool_call"
    ? { kind: "item", type: item.type, at, callId: item.callId, status: item.status }
    : { kind: "item", type: item.type, at }
}

/** Bumped after MCP toggles so the sidebar rereads provider config. */
export const [mcpRevision, setMcpRevision] = createSignal(0)

type CatalogModel = NonNullable<Awaited<ReturnType<typeof api.providers.listModels>>["models"]>[number]
/** Each provider's models (display names like "Opus 5.5", thinking options), fetched on connect. */
export const [catalog, setCatalog] = createStore<Record<string, CatalogModel[]>>({})

export async function loadCatalog() {
  const results = await Promise.all(PROVIDERS.map((provider) => api.providers.listModels(provider).catch(() => undefined)))
  for (const [index, result] of results.entries()) if (result?.models) setCatalog(PROVIDERS[index]!, reconcile(result.models))
}

export const findModel = (provider: string, id?: string | null) => {
  const models = catalog[provider] ?? []
  return models.find((model) => model.id === id) ?? (id ? undefined : models.find((model) => model.isDefault))
}
export const modelLabel = (provider: string, id?: string | null) => findModel(provider, id)?.label ?? id ?? "default model"
/** OpenCode shows the provider's product name; Paseo's Claude provider is Claude Code. */
export const providerName = (provider: string) => ({ claude: "Claude Code", codex: "Codex" })[provider] ?? provider

/** One entry per provider account, as the daemon reports them (same data as the Paseo app); a failed poll keeps `lastSuccessful`. */
export const [usage, setUsage] = createSignal<UsageReportEntry[]>()

/** Hosts without usage reports only have the per-provider list; present it as entries. */
export function legacyReport(provider: PaseoProviderUsageResult["providers"][number]): UsageReportEntry {
  return {
    id: provider.providerId,
    sourceId: provider.providerId,
    sourceLabel: provider.displayName,
    account: {},
    fetchedAt: provider.fetchedAt ?? new Date().toISOString(),
    report:
      provider.status === "available"
        ? { status: "available", windows: provider.windows, planLabel: provider.planLabel ?? undefined }
        : { status: "error", error: provider.error ?? "" },
  }
}

export async function refreshUsage() {
  // A failed refresh leaves the last reports in place.
  if (supportsUsageReports(daemon.getLastServerInfoMessage()?.features)) {
    const result = await daemon.listUsageReports().catch(() => undefined)
    if (result) setUsage(result.reports)
    return
  }
  const result = await api.providers.listUsage().catch(() => undefined)
  if (result) setUsage(result.providers.map(legacyReport))
}

let closeTimeline: (() => void) | undefined

type SubagentFeedMessage = Parameters<Parameters<ReturnType<typeof daemon.observeEvents>["subscribe"]>[0]["update"]>[0]
type SubagentUpdate = Extract<Extract<SubagentFeedMessage, { type: "agent.provider_subagents.update" }>["payload"], { kind: "timeline" }>

/** Read-only timeline of a provider-native subagent: one fetch for the history, then the daemon's pushed items. */
export async function openSubagentTimeline(parentId: string, subagentId: string) {
  closeTimeline?.()
  const open = ++opened
  older = undefined
  const key = `${parentId}:${subagentId}`
  setTimeline({ agentId: key, rows: [], revision: timeline.revision + 1, times: [], marks: [], loading: true, hasOlder: false, startCursor: undefined })
  let lastSeq = 0
  let epoch: string | undefined
  // Pushed items buffer until the first page lands; those it already holds are dropped by seq.
  let buffered: SubagentUpdate[] | undefined = []
  const apply = (update: SubagentUpdate) => {
    if (update.seq <= lastSeq) return
    lastSeq = update.seq
    setTimeline(
      produce((draft) => {
        const before = draft.rows.length
        applyTimelineItem(draft.rows, update.item)
        if (draft.rows.length > before) draft.times.push(Date.parse(update.timestamp))
        draft.revision++
      }),
    )
  }
  const load = async () => {
    const page = await daemon.fetchProviderSubagentTimeline(parentId, subagentId, { direction: "tail", limit: 0 })
    if (open !== opened) return
    if (page.error) throw new Error(page.error)
    lastSeq = page.rows.reduce((max, row) => Math.max(max, row.seqEnd ?? row.seq ?? 0), 0)
    epoch = page.epoch
    setTimeline({
      rows: page.rows.map((row) => row.item),
      revision: timeline.revision + 1,
      times: page.rows.map((row) => Date.parse(row.timestamp)),
      loading: false,
    })
    const pending = buffered ?? []
    buffered = undefined
    for (const update of pending) apply(update)
  }
  // Subscribed before the fetch, so nothing falls between the page and the feed.
  const feed = daemon.observeEvents(["agent.provider_subagents.update"])
  let active = false
  feed.subscribe({
    // Updates aren't replayed across a reconnect; read the history again once the feed is back.
    snapshot() {
      if (active) void load().catch(() => {})
      active = true
    },
    update(message) {
      if (message.type !== "agent.provider_subagents.update" || open !== opened) return
      const update = message.payload
      if (update.kind !== "timeline" || update.parentAgentId !== parentId || update.subagentId !== subagentId) return
      if (buffered) buffered.push(update)
      // A new epoch means the child's history was rewritten.
      else if (epoch && update.epoch !== epoch) void load().catch(() => {})
      else apply(update)
    },
  })
  closeTimeline = () => void feed.release().catch(() => {})
  await load()
}

export async function openTimeline(agentId: string | undefined) {
  closeTimeline?.()
  closeTimeline = undefined
  const open = ++opened
  older = undefined
  setTimeline({ agentId, rows: [], times: [], marks: [], loading: !!agentId, hasOlder: false, startCursor: undefined })
  if (!agentId) return

  const handle = api.agents.ref(agentId)
  let lastSeq = 0
  let buffered: PaseoAgentStream[] | undefined = []
  const mark = (value: Mark) => setTimeline("marks", produce((marks) => void marks.push(value)))
  const apply = ({ event, seq, timestamp }: PaseoAgentStream) => {
    const at = Date.parse(timestamp)
    if (event.type === "turn_started") return mark({ kind: "turn_started", at })
    if (event.type === "turn_completed") return mark({ kind: "turn_completed", at, outputTokens: event.usage?.outputTokens })
    if (event.type !== "timeline") return
    if (seq !== undefined && seq <= lastSeq) return // already in the fetched history
    if (seq !== undefined) lastSeq = seq
    setTimeline(
      produce((draft) => {
        const before = draft.rows.length
        applyTimelineItem(draft.rows, event.item)
        if (draft.rows.length > before) draft.times.push(at)
        // A delta merged into the last message adds nothing the mark readers use (first output, user and tool marks);
        // one mark per delta made every footer/metrics rescan grow with the stream.
        else if (event.item.type === "assistant_message" || event.item.type === "reasoning") return
        draft.revision++
        draft.marks.push(itemMark(event.item, at))
      }),
    )
  }
  // Live messages buffer while a load runs; only the newest load applies its page and flushes them.
  let loads = 0
  let stale = false
  let retryAfter = 0
  const load = async () => {
    const current = ++loads
    stale = true
    buffered ??= []
    try {
      const page = await handle.timeline.refetch({ direction: "before", limit: PAGE, projection: "projected" })
      if (open !== opened || current !== loads) return
      lastSeq = page.endCursor?.seq ?? 0
      const entries = dropStaleCompactions(page.entries)
      refetched++
      // Merged in place by position, so rows a reconnect refetch left unchanged keep their store nodes (and mounted views).
      batch(() => {
        setTimeline("rows", reconcile(entries.map((entry) => entry.item), { merge: true }))
        setTimeline("times", reconcile(entries.map((entry) => Date.parse(entry.timestamp)), { merge: true }))
        setTimeline("marks", reconcile(entries.map((entry) => itemMark(entry.item, Date.parse(entry.timestamp))), { merge: true }))
        setTimeline({
          // After a rewind the daemon reports hasOlder with no cursor to page from.
          hasOlder: page.hasOlder && !!page.startCursor,
          startCursor: page.startCursor ?? undefined,
          revision: timeline.revision + 1,
        })
      })
      stale = false
    } finally {
      if (open === opened && current === loads && buffered) {
        if (stale) retryAfter = Date.now() + 3000
        setTimeline("loading", false)
        const pending = buffered
        buffered = undefined
        // Flush even on failure; a later live message retries after the cooldown.
        for (const message of pending) apply(message)
      }
    }
  }
  const reload = () => void load().catch((error) => console.error("Timeline refetch failed:", error))

  const unsubscribe = handle.timeline.subscribe((message) => {
    // Reconnects and history rewrites invalidate what we have; refetch.
    if (message.event.type === "replacement" || message.event.type === "subscription_restored") return reload()
    if (!("timestamp" in message)) return
    if (stale && !buffered && Date.now() >= retryAfter) reload()
    if (buffered) buffered.push(message)
    else apply(message)
  })
  closeTimeline = unsubscribe
  await unsubscribe.ready
  await load()
}
