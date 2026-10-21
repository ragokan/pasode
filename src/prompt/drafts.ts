import type { PromptSnapshot } from "./types"

// Like OpenCode's draft-stash.ts (MIT): one unsent draft per session (undefined is the home screen), in memory only.
export type Draft = PromptSnapshot & { cursor: number }

const drafts = new Map<string | undefined, Draft>()

export function saveDraft(id: string | undefined, draft: Draft) {
  if (draft.text || draft.images.length) drafts.set(id, draft)
  else drafts.delete(id)
}

/** Consumes the draft, so a stale copy never shadows newer input. */
export function takeDraft(id: string | undefined) {
  const draft = drafts.get(id)
  drafts.delete(id)
  return draft
}
