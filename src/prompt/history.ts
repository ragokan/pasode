import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Pasted } from "./paste"

// Ported from OpenCode prompt/history.tsx (MIT): the last 50 submitted prompts, ↑/↓ at the prompt's edges walk them.
export type HistoryEntry = { text: string; pasted: Pasted[] }
export const MAX_HISTORY = 50

export function parseHistory(content: string): HistoryEntry[] {
  return content
    .split("\n")
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Partial<HistoryEntry> | null
        return typeof value?.text === "string" && Array.isArray(value.pasted) ? [value as HistoryEntry] : []
      } catch {
        return [] // blank or torn line
      }
    })
    .slice(-MAX_HISTORY)
}

const lines = (entries: HistoryEntry[]) => entries.map((entry) => JSON.stringify(entry) + "\n").join("")

export function createHistory(file: string) {
  let entries: HistoryEntry[] | undefined
  // 0 is "the prompt being typed"; -1 is the newest entry, -2 the one before.
  let index = 0
  // Best-effort persistence, like kv.json: a read-only state dir only costs the history across restarts.
  const write = (run: () => void) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      run()
    } catch {}
  }
  const load = () =>
    (entries ??= (() => {
      try {
        return parseHistory(readFileSync(file, "utf8"))
      } catch {
        return []
      }
    })())

  return {
    /** The entry one step back (-1) or forward (1) from where you are; undefined when `input` isn't a history entry or empty (so ↑ moves the cursor) or at either end. */
    move(direction: 1 | -1, input: string): HistoryEntry | undefined {
      const list = load()
      if (input.length && (index === 0 || list.at(index)?.text !== input)) return
      const next = index + direction
      if (next > 0 || -next > list.length) return
      index = next
      return next === 0 ? { text: "", pasted: [] } : list.at(next)
    },
    append(entry: HistoryEntry) {
      const list = load()
      index = 0
      if (JSON.stringify(list.at(-1)) === JSON.stringify(entry)) return
      list.push(entry)
      if (list.length <= MAX_HISTORY) return write(() => appendFileSync(file, lines([entry])))
      list.splice(0, list.length - MAX_HISTORY)
      write(() => writeFileSync(file, lines(list)))
    },
  }
}

// Same state directory as kv.json.
export const promptHistory = createHistory(path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pasode", "prompt-history.jsonl"))
