import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MAX_HISTORY_ENTRIES, parseHistory, PromptHistory, readHistory, writeHistory } from "./history"

test("history walks backward and restores the draft past the newest entry", () => {
  const history = new PromptHistory([{ text: "first", mode: "normal" }, { text: "pwd", mode: "shell" }])
  const draft = { text: "unfinished\nmessage", mode: "normal" as const }
  expect(history.move(1, draft)).toBeUndefined()
  expect(history.move(-1, draft)).toEqual({ text: "pwd", mode: "shell" })
  expect(history.move(-1, { text: "pwd", mode: "shell" })).toEqual({ text: "first", mode: "normal" })
  expect(history.move(-1, draft)).toBeUndefined()
  expect(history.move(1, draft)).toEqual({ text: "pwd", mode: "shell" })
  expect(history.move(1, draft)).toEqual(draft)
  expect(history.browsing).toBe(false)
  expect(history.move(1, draft)).toBeUndefined()
})

test("history caps entries, skips consecutive duplicates and resets navigation", () => {
  const history = new PromptHistory()
  for (let i = 0; i <= MAX_HISTORY_ENTRIES; i++) history.append({ text: String(i), mode: "normal" })
  expect(history.entries).toHaveLength(MAX_HISTORY_ENTRIES)
  expect(history.entries[0]?.text).toBe("1")
  history.move(-1, { text: "draft", mode: "normal" })
  history.append({ text: String(MAX_HISTORY_ENTRIES), mode: "normal" })
  expect(history.entries).toHaveLength(MAX_HISTORY_ENTRIES)
  expect(history.browsing).toBe(false)
  history.append({ text: String(MAX_HISTORY_ENTRIES), mode: "shell" })
  expect(history.entries.at(-1)?.mode).toBe("shell")
})

test("history parsing ignores malformed JSON and wrong shapes", () => {
  expect(parseHistory('broken\nnull\n{"text":2,"mode":"normal"}\n{"text":"no mode"}\n{"text":"bad","mode":"other"}\n{"text":"ok","mode":"normal"}\n'))
    .toEqual([{ text: "ok", mode: "normal" }])
})

test("history persists atomically to a private, capped JSONL file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-history-test-"))
  const file = path.join(directory, "state", "history.jsonl")
  try {
    expect(readHistory(file)).toEqual([])
    const entries = Array.from({ length: MAX_HISTORY_ENTRIES + 4 }, (_, i) => ({ text: `line ${i}\n第二行`, mode: "normal" as const }))
    await writeHistory(entries, file)
    expect(readHistory(file)).toEqual(entries.slice(-MAX_HISTORY_ENTRIES))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(MAX_HISTORY_ENTRIES)
    await writeFile(file, 'invalid\n{"text":"recovered","mode":"shell"}\n')
    expect(readHistory(file)).toEqual([{ text: "recovered", mode: "shell" }])
    await writeHistory([], file)
    expect(readHistory(file)).toEqual([])
    await Promise.all([writeHistory(entries.slice(0, 1), file), writeHistory(entries.slice(0, 2), file)])
    expect(readHistory(file)).toEqual(entries.slice(0, 2))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
