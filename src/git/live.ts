// Live checkout state from the daemon (so it works for sessions on a remote host): one shared
// `checkout_status_update` subscription for every watched directory, and a diff subscription per view.
import type { ParsedDiffFile } from "@getpaseo/protocol/messages"
import { createEffect, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { daemon } from "../paseo"
import type { PrPayload, Status } from "./model"

const [statuses, setStatuses] = createStore<Record<string, Status>>({})
const [prs, setPrs] = createStore<Record<string, PrPayload>>({})
const watched = new Map<string, number>()
let events: ReturnType<typeof daemon.observeEvents> | undefined

export const statusOf = (cwd: string | undefined) => (cwd ? statuses[cwd] : undefined)
export const prOf = (cwd: string | undefined) => (cwd ? prs[cwd] : undefined)

/** Pull the daemon's git state again: a plain directory isn't a watched workspace, so nothing pushes its changes. */
export async function refreshStatus(cwd: string, force = false) {
  if (force) await daemon.checkoutRefresh(cwd).catch(() => {})
  const status = await daemon.getCheckoutStatus(cwd).catch(() => undefined)
  if (status && watched.has(cwd)) setStatuses(cwd, reconcile(status))
}

/** The branch's pull request (asks the forge, so only on demand; status events carry it afterwards). */
export async function refreshPr(cwd: string) {
  const pr = await daemon.checkoutPrStatus(cwd).catch(() => undefined)
  if (pr && watched.has(cwd)) setPrs(cwd, reconcile(pr))
}

function releaseEvents() {
  if (watched.size) return
  void events?.release().catch(() => {})
  events = undefined
}

/** Keeps `statusOf(cwd)` live until the returned function is called. The status events cover every workspace; only watched ones are kept. */
export function watchStatus(cwd: string) {
  watched.set(cwd, (watched.get(cwd) ?? 0) + 1)
  if (!events) {
    events = daemon.observeEvents(["checkout_status_update"])
    events.subscribe({
      // Reconnects resubscribe; what changed meanwhile is unknown.
      snapshot: () => watched.forEach((_, dir) => void refreshStatus(dir)),
      update(message) {
        if (message.type !== "checkout_status_update" || !watched.has(message.payload.cwd)) return
        const { prStatus, subscriptionId, ...status } = message.payload
        setStatuses(message.payload.cwd, reconcile(status as Status))
        if (prStatus) setPrs(message.payload.cwd, reconcile(prStatus))
      },
    })
  }
  void refreshStatus(cwd)
  return () => {
    const left = (watched.get(cwd) ?? 1) - 1
    if (left) return void watched.set(cwd, left)
    watched.delete(cwd)
    setStatuses(produce((all) => void delete all[cwd]))
    setPrs(produce((all) => void delete all[cwd]))
    // Deferred: switching directories stops one watch right before starting the next.
    if (!watched.size) queueMicrotask(releaseEvents)
  }
}

export type DiffCompare = { mode: "uncommitted" } | { mode: "base"; baseRef?: string }
export type DiffState = { files: ParsedDiffFile[]; loading: boolean; error?: string; tooLarge?: boolean }

/** Live diff of `cwd`; resubscribes when the directory or comparison changes, unsubscribes with the owner. */
export function useCheckoutDiff(cwd: () => string | undefined, compare: () => DiffCompare) {
  const [state, setState] = createStore<DiffState>({ files: [], loading: true })
  createEffect(() => {
    const dir = cwd()
    const against = compare()
    if (!dir) return
    setState({ files: [], loading: true, error: undefined, tooLarge: false })
    const subscription = daemon.observeCheckoutDiff(dir, against)
    let refresh: ReturnType<typeof setTimeout> | undefined
    let seen: string | undefined
    const apply = (payload: { files: ParsedDiffFile[]; error: { message: string } | null; diffTooLarge?: boolean }) => {
      setState({ loading: false, error: payload.error?.message, tooLarge: !!payload.diffTooLarge })
      setState("files", reconcile(payload.files, { key: "path" }))
      // The tree changed, so the branch/dirty state may have too (the refresh only runs when the change list differs, so it can't feed itself).
      const fingerprint = payload.files.map((file) => `${file.path}:${file.additions}:${file.deletions}`).join("\n")
      if (seen !== undefined && seen !== fingerprint) {
        clearTimeout(refresh)
        refresh = setTimeout(() => void refreshStatus(dir, true), 800)
      }
      seen = fingerprint
    }
    subscription.subscribe({
      snapshot: apply,
      update: (message) => message.type === "checkout_diff_update" && apply(message.payload),
      error: (error) => setState({ loading: false, error: error instanceof Error ? error.message : String(error) }),
    })
    onCleanup(() => {
      clearTimeout(refresh)
      void subscription.release().catch(() => {})
    })
  })
  return state
}

/** Reactive `statusOf(cwd())` for as long as the calling owner lives. */
export function useCheckoutStatus(cwd: () => string | undefined) {
  createEffect(() => {
    const dir = cwd()
    if (dir) onCleanup(watchStatus(dir))
  })
  return () => statusOf(cwd())
}
