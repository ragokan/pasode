import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { PromptSubmit } from "./types"

// Adapted from OpenCode's prompt/history.tsx (MIT); never persist image payloads.
export type HistoryEntry = Pick<PromptSubmit, "text" | "mode">
export const MAX_HISTORY_ENTRIES = 200
export const historyPath = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "pascode", "prompt-history.jsonl")

export function parseHistory(text: string): HistoryEntry[] {
  return text.split("\n").flatMap<HistoryEntry>((line) => {
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") return []
      if (!("mode" in value) || (value.mode !== "normal" && value.mode !== "shell")) return []
      return [{ text: value.text, mode: value.mode }]
    } catch {
      return []
    }
  }).slice(-MAX_HISTORY_ENTRIES)
}

export function readHistory(file = historyPath): HistoryEntry[] {
  try {
    return parseHistory(readFileSync(file, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

let writes = Promise.resolve()

export function writeHistory(entries: HistoryEntry[], file = historyPath) {
  // Serialize remounting prompts' writes; an older snapshot must not replace a newer one.
  const snapshot = entries.slice(-MAX_HISTORY_ENTRIES)
  const result = writes.catch(() => {}).then(() => persistHistory(snapshot, file))
  writes = result
  return result
}

// shortcut: history is shared within one process; add file locking for concurrent clients.
async function persistHistory(entries: HistoryEntry[], file: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temp, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 })
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

export class PromptHistory {
  entries: HistoryEntry[]
  private index: number
  private draft: HistoryEntry = { text: "", mode: "normal" }

  constructor(entries: HistoryEntry[] = []) {
    this.entries = entries.slice(-MAX_HISTORY_ENTRIES)
    this.index = this.entries.length
  }

  get browsing() { return this.index < this.entries.length }

  reset() { this.index = this.entries.length }

  append(entry: HistoryEntry) {
    const previous = this.entries.at(-1)
    if (previous?.text !== entry.text || previous.mode !== entry.mode)
      this.entries = [...this.entries, { ...entry }].slice(-MAX_HISTORY_ENTRIES)
    this.reset()
  }

  move(direction: -1 | 1, current: HistoryEntry): HistoryEntry | undefined {
    if (!this.entries.length || (direction === 1 && !this.browsing)) return
    if (!this.browsing) this.draft = { ...current }
    const next = Math.max(0, Math.min(this.entries.length, this.index + direction))
    if (next === this.index) return
    this.index = next
    return { ...(this.browsing ? this.entries[this.index]! : this.draft) }
  }
}
