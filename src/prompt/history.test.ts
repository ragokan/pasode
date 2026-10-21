import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHistory, MAX_HISTORY, parseHistory } from "./history"

const dir = mkdtempSync(path.join(os.tmpdir(), "pasode-history-"))
process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
const entry = (text: string) => ({ text, pasted: [] })
let n = 0
const fresh = () => path.join(dir, `history-${n++}.jsonl`)

test("↑ walks back through submitted prompts, ↓ forward, and stops at both ends", () => {
  const history = createHistory(fresh())
  expect(history.move(-1, "")).toBeUndefined() // nothing yet
  for (const text of ["one", "two", "three"]) history.append(entry(text))
  expect(history.move(-1, "")?.text).toBe("three")
  expect(history.move(-1, "three")?.text).toBe("two")
  expect(history.move(-1, "two")?.text).toBe("one")
  expect(history.move(-1, "one")).toBeUndefined() // oldest
  expect(history.move(1, "one")?.text).toBe("two")
  expect(history.move(1, "two")?.text).toBe("three")
  expect(history.move(1, "three")).toEqual(entry("")) // back to the empty prompt
  expect(history.move(1, "")).toBeUndefined() // newest end: the host's own ↓ takes over
})

test("typing something other than an entry stops ↑/↓ from replacing it", () => {
  const history = createHistory(fresh())
  history.append(entry("sent"))
  expect(history.move(-1, "half-typed")).toBeUndefined()
  expect(history.move(-1, "")?.text).toBe("sent")
  expect(history.move(-1, "sent edited")).toBeUndefined()
  history.append(entry("next"))
  expect(history.move(-1, "")?.text).toBe("next") // submitting resets the position
})

test("an immediate repeat isn't stored twice, and keeps pasted parts", () => {
  const file = fresh()
  const history = createHistory(file)
  const big = { text: "see [Pasted ~3 lines]", pasted: [{ token: "[Pasted ~3 lines]", text: "a\nb\nc" }] }
  history.append(big)
  history.append(big)
  history.append(entry("other"))
  expect(parseHistory(readFileSync(file, "utf8"))).toEqual([big, entry("other")])
  const restarted = createHistory(file)
  expect(restarted.move(-1, "")).toEqual(entry("other"))
  expect(restarted.move(-1, "other")).toEqual(big)
})

test("keeps the newest 50, on disk too, and survives a restart and torn lines", () => {
  const file = fresh()
  const history = createHistory(file)
  for (let i = 0; i < MAX_HISTORY + 5; i++) history.append(entry(`prompt ${i}`))
  const saved = parseHistory(readFileSync(file, "utf8"))
  expect(saved).toHaveLength(MAX_HISTORY)
  expect(saved[0]!.text).toBe("prompt 5")
  writeFileSync(file, `${readFileSync(file, "utf8")}{"text":"torn\n\nnot json\n{"text":1,"pasted":[]}\n`)
  const restarted = createHistory(file)
  expect(restarted.move(-1, "")?.text).toBe(`prompt ${MAX_HISTORY + 4}`)
})

test("a state directory that can't be written only costs persistence", () => {
  const blocked = path.join(dir, "blocked")
  writeFileSync(blocked, "a file, not a directory")
  const history = createHistory(path.join(blocked, "history.jsonl"))
  history.append(entry("still works"))
  expect(history.move(-1, "")?.text).toBe("still works")
})
