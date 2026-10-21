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

/** The real text: one pass, so a pasted text that mentions another token (or "$&") stays as pasted. */
export function expandPasted(text: string, pasted: readonly Pasted[]) {
  if (!pasted.length) return text
  const byToken = new Map(pasted.map((part) => [part.token, part.text]))
  const pattern = [...byToken.keys()].map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return text.replace(new RegExp(pattern, "g"), (token) => byToken.get(token)!)
}

/** `next` after `base` (a blank line between), renaming tokens that clash; used to restore a stash or queued prompt onto a draft. */
export function appendSnapshot(base: PromptSnapshot, next: PromptSnapshot): PromptSnapshot {
  if (!base.text && !base.images.length) return next
  const taken = new Set(base.pasted.map((part) => part.token))
  let text = next.text
  const pasted = next.pasted.map((part) => {
    const token = nextToken(part.token, taken)
    taken.add(token)
    text = text.split(part.token).join(token)
    return { ...part, token }
  })
  return { text: base.text ? `${base.text}\n\n${text}` : text, pasted: [...base.pasted, ...pasted], images: [...base.images, ...next.images] }
}
