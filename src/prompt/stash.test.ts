import { expect, test } from "bun:test"
import { kvGet } from "../config"
import { popStash, pushStash, removeStash, stashList, stashSnapshot } from "./stash"

const snapshot = (text: string) => ({ text, pasted: [], images: [] })

test("the stash is last-in first-out, persisted without images, and capped at 50", () => {
  const image = { data: "x", mimeType: "image/png" }
  pushStash(snapshot("one"))
  pushStash({ text: "two [Pasted ~3 lines]", pasted: [{ token: "[Pasted ~3 lines]", text: "a\nb\nc" }], images: [image] })
  expect(stashList().map((entry) => entry.text)).toEqual(["one", "two [Pasted ~3 lines]"])
  const saved = kvGet<{ text: string; images?: unknown; pasted?: unknown[] }[]>("stash", [])
  expect(saved.map((entry) => entry.text)).toEqual(["one", "two [Pasted ~3 lines]"])
  expect(saved[1]!.images).toBeUndefined()
  expect(saved[1]!.pasted).toHaveLength(1)

  const top = popStash()!
  expect(stashSnapshot(top).images).toEqual([image]) // still held for this run
  expect(stashList().map((entry) => entry.text)).toEqual(["one"])
  pushStash(snapshot("three"))
  removeStash(0)
  expect(stashList().map((entry) => entry.text)).toEqual(["three"])
  expect(popStash()?.text).toBe("three")
  expect(popStash()).toBeUndefined()

  for (let i = 0; i < 55; i++) pushStash(snapshot(`entry ${i}`))
  expect(stashList()).toHaveLength(50)
  expect(stashList()[0]!.text).toBe("entry 5")
  while (popStash());
})

test("an entry from an older or hand-edited file still restores", () => {
  expect(stashSnapshot({ text: "plain", timestamp: 1 })).toEqual({ text: "plain", pasted: [], images: [] })
})
