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

// The input now showing each session, so a failed send can come back to it even when a different Prompt instance
// than the one that sent it shows the session by then (home → session remounts the prompt).
const showing = new Map<string | undefined, (failed: PromptSnapshot) => void>()

export const showSession = (id: string | undefined, receive: (failed: PromptSnapshot) => void) => showing.set(id, receive)
export const hideSession = (id: string | undefined, receive: (failed: PromptSnapshot) => void) => showing.get(id) === receive && showing.delete(id)
export const showingSession = (id: string | undefined) => showing.get(id)
