import { createPaseoApi, type PaseoAgent, type PaseoAgentStream, type PaseoProviderUsageResult, type PaseoWorkspace } from "@getpaseo/client"
import { DaemonClient } from "@getpaseo/client/internal/daemon-client"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSignal } from "solid-js"
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
  const list = await api.agents.list({ filter: { includeArchived: false }, page: { limit: 200 }, subscribe: {} })
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

async function watchWorkspaces() {
  const titles = (entries: PaseoWorkspace[]) => reconcile(Object.fromEntries(entries.map((workspace) => [workspace.id, workspace.title ?? null])))
  const list = await api.workspaces.list({ page: { limit: 200 }, subscribe: {} })
  setWorkspaceTitles(titles(list.entries))
  list.subscription.subscribe({
    snapshot: ({ entries }) => setWorkspaceTitles(titles(entries)),
    update(message) {
      if (message.type !== "workspace_update") return
      const update = message.payload
      if (update.kind === "upsert") setWorkspaceTitles(update.workspace.id, update.workspace.title ?? null)
      else setWorkspaceTitles(produce((all) => delete all[update.id]))
    },
  })
}

/** Whether `agent` is a subagent of `ancestorId`, directly or through other subagents. */
export const spawnedBy = (agent: PaseoAgent | undefined, ancestorId: string): boolean => {
  const parent = agent?.labels?.["paseo.parent-agent-id"]
  return !!parent && (parent === ancestorId || spawnedBy(agents[parent], ancestorId))
}

export const active = (agent: PaseoAgent) => agent.status === "running" || !!agent.pendingPermissions?.length
/** Idle, but a subagent it spawned is still working, so the session isn't done. */
export const waiting = (agent: PaseoAgent) => !active(agent) && Object.values(agents).some((other) => active(other) && spawnedBy(other, agent.id))

/** The agent's own workspace, if no other live agent shares it; subagents it spawned there don't count. */
export const ownWorkspace = (agent: PaseoAgent) =>
  agent.workspaceId &&
  Object.values(agents).every((other) => other.id === agent.id || other.workspaceId !== agent.workspaceId || spawnedBy(other, agent.id))
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
  times: number[]
  marks: Mark[]
  loading: boolean
  hasOlder: boolean
  startCursor?: Cursor
}>({ rows: [], times: [], marks: [], loading: false, hasOlder: false })

const PAGE = 300

/** Bumped on every open, so a reply for an earlier open (even of the same session) is dropped. */
let opened = 0
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
  const { agentId, startCursor, hasOlder, rows } = timeline
  if (!agentId || !startCursor || !hasOlder) return false
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "before", cursor: startCursor, limit: PAGE, projection: "projected" })
  if (open !== opened || timeline.rows !== rows) return false
  setTimeline(
    produce((draft) => {
      const entries = dropStaleCompactions(page.entries)
      draft.rows.unshift(...entries.map((entry) => entry.item))
      draft.times.unshift(...entries.map((entry) => Date.parse(entry.timestamp)))
      draft.marks.unshift(...entries.map((entry) => itemMark(entry.item, Date.parse(entry.timestamp))))
      draft.hasOlder = page.hasOlder && !!page.startCursor
      draft.startCursor = page.startCursor ?? undefined
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

/** Claude/Codex plan windows as the daemon reports them (same data as the Paseo app). */
export const [usage, setUsage] = createSignal<PaseoProviderUsageResult["providers"]>()

export async function refreshUsage() {
  const result = await api.providers.listUsage().catch(() => undefined)
  if (result) setUsage(result.providers)
}

let closeTimeline: (() => void) | undefined

/** Read-only timeline of a provider-native subagent; Paseo has no stream for these, so poll while open. */
export async function openSubagentTimeline(parentId: string, subagentId: string) {
  closeTimeline?.()
  const open = ++opened
  older = undefined
  const key = `${parentId}:${subagentId}`
  setTimeline({ agentId: key, rows: [], times: [], marks: [], loading: true, hasOlder: false, startCursor: undefined })
  const load = async () => {
    const page = await daemon.fetchProviderSubagentTimeline(parentId, subagentId, { direction: "tail", limit: 0 })
    if (open !== opened) return
    if (page.error) throw new Error(page.error)
    setTimeline({
      rows: page.rows.map((row) => row.item),
      times: page.rows.map((row) => Date.parse(row.timestamp)),
      loading: false,
    })
  }
  const timer = setInterval(() => void load().catch(() => {}), 2000)
  closeTimeline = () => clearInterval(timer)
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
      setTimeline({
        rows: entries.map((entry) => entry.item),
        times: entries.map((entry) => Date.parse(entry.timestamp)),
        marks: entries.map((entry) => itemMark(entry.item, Date.parse(entry.timestamp))),
        // After a rewind the daemon reports hasOlder with no cursor to page from.
        hasOlder: page.hasOlder && !!page.startCursor,
        startCursor: page.startCursor ?? undefined,
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
