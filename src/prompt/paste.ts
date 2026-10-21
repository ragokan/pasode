import type { PromptSnapshot } from "./types"

// Ported from OpenCode prompt/part.ts + component/prompt/index.tsx (MIT): big pastes collapse to a token in the input.

export type Pasted = { token: string; text: string }

const nextToken = (token: string, taken: Set<string>) => {
  let next = token
  for (let n = 2; taken.has(next); n++) next = token.replace(/\]$/, ` #${n}]`)
  return next
}

/** A paste of three or more lines, or over 150 characters, becomes "[Pasted ~N lines]"; undefined when it stays inline. */
export function summarizePaste(text: string, existing: readonly Pasted[]): Pasted | undefined {
  const pasted = text.trim()
  const lines = pasted.split("\n").length
  if (lines < 3 && pasted.length <= 150) return
  return { token: nextToken(`[Pasted ~${lines} lines]`, new Set(existing.map((part) => part.token))), text: pasted }
}

/** One pass, so a replacement that mentions another token (or "$&") stays as written. */
function replaceTokens(text: string, replacements: Map<string, string>) {
  if (!replacements.size) return text
  const pattern = [...replacements.keys()].map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return text.replace(new RegExp(pattern, "g"), (token) => replacements.get(token)!)
}

/** The real text. */
export const expandPasted = (text: string, pasted: readonly Pasted[]) => replaceTokens(text, new Map(pasted.map((part) => [part.token, part.text])))

/** `next` after `base` (a blank line between), renaming tokens that clash; used to restore a stash or queued prompt onto a draft. */
export function appendSnapshot(base: PromptSnapshot, next: PromptSnapshot): PromptSnapshot {
  if (!base.text && !base.images.length) return next
  const clashing = new Set(base.pasted.map((part) => part.token))
  // Every token in play is taken, so a rename can't land on another of next's tokens; all renames apply in one pass.
  const taken = new Set([...clashing, ...next.pasted.map((part) => part.token)])
  const renamed = new Map<string, string>()
  const pasted = next.pasted.map((part) => {
    if (!clashing.has(part.token)) return part
    const token = nextToken(part.token, taken)
    taken.add(token)
    renamed.set(part.token, token)
    return { ...part, token }
  })
  const text = replaceTokens(next.text, renamed)
  return { text: base.text ? `${base.text}\n\n${text}` : text, pasted: [...base.pasted, ...pasted], images: [...base.images, ...next.images] }
}
