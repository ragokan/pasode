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
  /** Transient (not remembered): start in a new git worktree, optionally on this branch. */
  worktree?: { branch?: string }
  /** Transient: a fork's chat-history attachment, source title and directory. */
  fork?: { title: string; cwd: string; attachment: Attachment }
}
export const [draft, setDraft] = createSignal<Draft>(kvGet("draft", { provider: "claude" }))

/** A provider-native subagent (Claude Task / Codex child thread) shown read-only under its Paseo parent. */
export const [subagent, setSubagent] = createSignal<{ parentId: string; id: string; title: string }>()

type Prefs = {
  thinking: "show" | "hide" | "collapsed"
  details: boolean
  timestamps: boolean
  sidebar: "auto" | "show" | "hide"
  sidebarWidth: number
  diffs: "auto" | "unified" | "split"
  theme: string
  themeMode: "dark" | "light"
}
const defaults: Prefs = {
  thinking: config.session?.thinking ?? "show",
  details: config.session?.details ?? false,
  timestamps: config.session?.timestamps ?? false,
  sidebar: config.session?.sidebar ?? "auto",
  sidebarWidth: config.session?.sidebarWidth ?? 42,
  diffs: config.session?.diffs ?? "auto",
  theme: config.theme?.name ?? "monokai-pro-ristretto",
  themeMode: config.theme?.mode ?? "dark",
}
export const [prefs, setPrefsStore] = createStore<Prefs>({ ...defaults, ...kvGet<Partial<Prefs>>("prefs", {}) })

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  setPrefsStore(key, value as never)
  kvSet("prefs", { ...kvGet<Partial<Prefs>>("prefs", {}), [key]: value })
}

export function rememberDraft(value: Draft) {
  setDraft(value)
  const { worktree, fork, ...lasting } = value
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
