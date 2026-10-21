// OpenCode's model favorites and recents (model-preference.ts, MIT), kept in kv.json as "provider/model" ids.
import { createSignal } from "solid-js"
import { kvGet, kvSet } from "./config"
import type { SelectOption } from "./dialog"
import { daemon, findModel, providerName } from "./paseo"
import { current, draft, notify, rememberDraft, showError } from "./state"

const RECENT_LIMIT = 10
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [])
const stored = kvGet<{ favorite?: unknown; recent?: unknown }>("models", {})
const [saved, setSaved] = createSignal({ favorite: ids(stored.favorite), recent: ids(stored.recent) })
export const favoriteModels = () => saved().favorite
export const recentModels = () => saved().recent

function save(next: ReturnType<typeof saved>) {
  setSaved(next)
  kvSet("models", next)
}

/** The model just picked, newest first without repeats. */
export const rememberModel = (id: string) => save({ ...saved(), recent: [id, ...saved().recent.filter((item) => item !== id)].slice(0, RECENT_LIMIT) })
export const toggleFavorite = (id: string) =>
  save({ ...saved(), favorite: saved().favorite.includes(id) ? saved().favorite.filter((item) => item !== id) : [id, ...saved().favorite] })

const split = (id: string) => [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)] as [string, string]

/** Picker rows: Favorites, then Recent (without favorites), then everything else once. A row's `category` is its provider. */
export function modelSections(all: SelectOption<string>[], favorite: string[], recent: string[]) {
  const byId = new Map(all.map((option) => [option.value, option]))
  const section = (list: string[], category: string) =>
    list.flatMap((id) => {
      const option = byId.get(id)
      return option ? [{ ...option, category, description: option.category && providerName(option.category) }] : []
    })
  const top = [...section(favorite, "Favorites"), ...section(recent.filter((id) => !favorite.includes(id)), "Recent")]
  const shown = new Set(top.map((option) => option.value))
  return [...top, ...all.filter((option) => !shown.has(option.value))]
}

/** The recent model after `now`, wrapping; the newest when `now` isn't among them. */
export function nextRecent(recent: string[], now: string | undefined) {
  if (!recent.length) return undefined
  return recent[(recent.indexOf(now as string) + 1) % recent.length]
}

/** Sets the model on the open session, or on the draft the next session starts from (the picker and f2 share this). */
export function selectModel(id: string, label?: string) {
  const agent = current()
  const [provider, model] = split(id)
  if (agent) daemon.setAgentModel(agent.id, model).catch(showError)
  else rememberDraft({ ...draft(), provider, model, label: label ?? findModel(provider, model)?.label, thinking: undefined })
}

/** OpenCode's model.cycle_recent: step through recently picked models without reordering them. */
export function cycleRecentModel() {
  const agent = current()
  const provider = agent?.provider ?? draft().provider
  const now = agent ? `${provider}/${agent.model ?? agent.runtimeInfo?.model}` : `${provider}/${draft().model}`
  // A live session keeps its provider, and a model the catalog no longer lists can't be selected.
  const usable = recentModels().filter((id) => (!agent || id.startsWith(`${provider}/`)) && findModel(...split(id)))
  const next = nextRecent(usable, now)
  if (!next || next === now) return notify("No other recent model yet", "warning")
  selectModel(next)
}
