import { createSignal } from "solid-js"
import { kvGet, kvSet } from "../config"
import type { PromptSnapshot } from "./types"

// Ported from OpenCode prompt/stash.tsx (MIT): shelved prompts, newest last, kept in kv.json.
export type StashEntry = Partial<PromptSnapshot> & { text: string; timestamp: number }
const MAX_STASH = 50

const [entries, setEntries] = createSignal<StashEntry[]>(
  // kv.json is hand-editable; skip anything that isn't an entry.
  (kvGet<unknown>("stash", []) as StashEntry[]).filter((entry) => typeof entry?.text === "string" && typeof entry.timestamp === "number").slice(-MAX_STASH),
)
export const stashList = entries

// Images are only held for this run: base64 screenshots would bloat every kv.json write.
const save = (list: StashEntry[]) => {
  setEntries(list)
  kvSet("stash", list.map(({ images, ...entry }) => entry))
}

export const pushStash = (snapshot: PromptSnapshot) => save([...entries(), { ...snapshot, timestamp: Date.now() }].slice(-MAX_STASH))
export const removeStash = (index: number) => save(entries().filter((_, i) => i !== index))
export function popStash() {
  const entry = entries().at(-1)
  if (entry) removeStash(entries().length - 1)
  return entry
}
/** A stash entry as a prompt (older or hand-edited entries may lack the optional fields). */
export const stashSnapshot = (entry: StashEntry): PromptSnapshot => ({ text: entry.text, pasted: entry.pasted ?? [], images: entry.images ?? [] })
