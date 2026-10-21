import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { config, kvGet, kvSet } from "./config"
import { agents, api, openTimeline, type PaseoAgent } from "./paseo"

/** App state shared by the UI and plugins. */
export const [agentId, setAgentId] = createSignal<string>()
export const current = (): PaseoAgent | undefined => {
  const id = agentId()
  return id ? agents[id] : undefined
}

type Attachment = NonNullable<Parameters<(typeof api)["agents"]["create"]>[0]["attachments"]>[number]
export type Draft = {
  provider: string
  model?: string
  label?: string
  thinking?: string
  /** Transient: OpenCode's agent for the next session — "plan" starts in plan mode; Build (default) bypasses permissions. */
  agent?: "plan"
  /** Transient (not remembered): start in a new git worktree, optionally on this branch. */
  worktree?: { branch?: string }
  /** Transient: directory for the next session ("New session location: active session"); launch directory otherwise. */
  cwd?: string
  /** Transient: a fork's chat-history attachment, source title and directory. */
  fork?: { title: string; cwd: string; attachment: Attachment }
}
export const [draft, setDraft] = createSignal<Draft>(kvGet("draft", { provider: "claude" }))

/** A provider-native subagent (Claude Task / Codex child thread) shown read-only under its Paseo parent. */
export const [subagent, setSubagent] = createSignal<{ parentId: string; id: string; title: string }>()

export type Prefs = {
  thinking: "show" | "hide"
  markdown: "source" | "rendered"
  scrollbar: boolean
  images: boolean
  newLocation: "launch" | "inherit"
  permissions: "bypass" | "prompt"
  grouping: "auto" | "none"
  verbosity: "low" | "medium" | "high"
  tps: boolean
  details: boolean
  timestamps: boolean
  sidebar: "auto" | "show" | "hide"
  sidebarWidth: number
  diffs: "auto" | "unified" | "split"
  diffWrap: "word" | "none"
  theme: string
  themeMode: "dark" | "light"
  animations: boolean
  mouse: boolean
  copyOnSelect: boolean
  notifications: boolean
  terminalTitle: boolean
}
const defaults: Prefs = {
  thinking: config.session?.thinking ?? "show",
  markdown: config.session?.markdown ?? "rendered",
  scrollbar: config.session?.scrollbar ?? false,
  images: config.session?.image_preview ?? false,
  newLocation: config.session?.new_location ?? "launch",
  permissions: config.session?.permissions ?? "bypass",
  grouping: config.session?.grouping ?? "auto",
  verbosity: config.session?.verbosity ?? "medium",
  tps: config.session?.tps ?? true,
  details: config.session?.details ?? false,
  timestamps: config.session?.timestamps ?? false,
  sidebar: config.session?.sidebar ?? "auto",
  sidebarWidth: config.session?.sidebarWidth ?? 30,
  diffs: config.session?.diffs ?? "auto",
  diffWrap: "word",
  theme: config.theme?.name ?? "monokai-pro-ristretto",
  themeMode: config.theme?.mode ?? "dark",
  animations: config.animations ?? true,
  mouse: config.mouse ?? true,
  copyOnSelect: true,
  notifications: config.attention?.notifications ?? true,
  terminalTitle: true,
}
const saved = kvGet<Partial<Prefs> & { thinking?: string }>("prefs", {})
// The old "collapsed" thinking mode became OpenCode's verbosity grouping.
if (saved.thinking !== "show" && saved.thinking !== "hide") delete saved.thinking
export const [prefs, setPrefsStore] = createStore<Prefs>({ ...defaults, ...(saved as Partial<Prefs>) })

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefsStore(key, value as never)
  kvSet("prefs", { ...kvGet<Partial<Prefs>>("prefs", {}), [key]: value })
}

export function rememberDraft(value: Draft) {
  setDraft(value)
  const { worktree, fork, agent, cwd, ...lasting } = value
  kvSet("draft", lasting)
}

export type ToastVariant = "info" | "success" | "warning" | "error"
export const [toast, setToast] = createSignal<{ title?: string; message: string; variant: ToastVariant }>()
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function notify(message: string, variant: ToastVariant = "info", title?: string) {
  setToast({ message, variant, title })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => setToast(undefined), variant === "error" ? 6000 : 4000)
}
export const showError = (error: unknown) => notify(error instanceof Error ? error.message : String(error), "error")

export function navigate(id: string | undefined) {
  setSubagent(undefined)
  setAgentId(id)
  openTimeline(id).catch((error) => {
    showError(error)
    if (agentId() === id) navigate(undefined)
  })
}
