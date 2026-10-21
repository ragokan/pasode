// Mapping between the daemon's whole-session prompt index (seq, timestamp, preview) and the rows loaded here.
import type { AgentTimelineItem } from "./timeline"

export type Prompt = { seq: number; timestamp: string; preview: string }
type Hit = { seq: number; role: "user" | "assistant" }

/** How the daemon previews a prompt (whitespace collapsed, 120 chars). */
export const promptPreview = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * Time + text of each user message, numbered from the newest, so repeats ("continue") and rows that share a timestamp
 * (history the daemon rehydrated) stay apart. Loaded rows are the newest stretch of the history, so a message gets the
 * same key in the prompt index and among the loaded rows.
 */
function keyed<T>(items: T[], time: (item: T) => number, text: (item: T) => string) {
  const seen = new Map<string, number>()
  const keys = new Array<string>(items.length)
  for (let i = items.length - 1; i >= 0; i--) {
    const base = `${time(items[i]!)}|${text(items[i]!)}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    keys[i] = `${base}#${n}`
  }
  return keys
}

/** Key → index of each loaded user message. */
export function userRowKeys(rows: AgentTimelineItem[], times: number[]) {
  const users = rows.flatMap((row, index) => (row.type === "user_message" ? [{ index, text: row.text }] : []))
  const keys = keyed(users, ({ index }) => times[index]!, ({ text }) => promptPreview(text))
  return new Map(users.map(({ index }, i) => [keys[i]!, index]))
}

/** Each prompt's key (see userRowKeys). */
export function promptKeys(prompts: Prompt[]) {
  const keys = keyed(prompts, (prompt) => Date.parse(prompt.timestamp), (prompt) => prompt.preview)
  return new Map(prompts.map((prompt, i) => [prompt, keys[i]!]))
}

/** The index entry of the loaded user message at `index`. */
export function locatePrompt(prompts: Prompt[], rows: AgentTimelineItem[], times: number[], index: number) {
  const key = [...userRowKeys(rows, times)].find(([, at]) => at === index)?.[0]
  return [...promptKeys(prompts)].find(([, other]) => other === key)?.[0]
}

/** The prompts a search hit belongs to: a user hit is the prompt itself, an assistant hit the prompt of its turn. */
export function matchedPrompts(prompts: Prompt[], hits: Hit[]) {
  const found = new Map<number, "user" | "assistant">()
  for (const hit of hits) {
    const prompt = prompts.findLast((item) => item.seq <= hit.seq)
    if (!prompt) continue
    if (hit.role === "user" || !found.has(prompt.seq)) found.set(prompt.seq, hit.role)
  }
  return found
}
