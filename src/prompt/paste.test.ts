import { expect, test } from "bun:test"
import { appendSnapshot, expandPasted, summarizePaste } from "./paste"

test("pastes of three lines or more, or over 150 characters, collapse to a token", () => {
  expect(summarizePaste("one line", [])).toBeUndefined()
  expect(summarizePaste("a\nb", [])).toBeUndefined()
  expect(summarizePaste("a\nb\nc", [])).toEqual({ token: "[Pasted ~3 lines]", text: "a\nb\nc" })
  expect(summarizePaste("x".repeat(150), [])).toBeUndefined()
  expect(summarizePaste("x".repeat(151), [])?.token).toBe("[Pasted ~1 lines]")
  expect(summarizePaste("\n\na\nb\nc\n\n", [])).toEqual({ token: "[Pasted ~3 lines]", text: "a\nb\nc" }) // trimmed, like OpenCode
})

test("a second paste of the same size gets its own token", () => {
  const first = summarizePaste("a\nb\nc", [])!
  const second = summarizePaste("d\ne\nf", [first])!
  const third = summarizePaste("g\nh\ni", [first, second])!
  expect([first.token, second.token, third.token]).toEqual(["[Pasted ~3 lines]", "[Pasted ~3 lines #2]", "[Pasted ~3 lines #3]"])
  expect(expandPasted("[Pasted ~3 lines #2] then [Pasted ~3 lines] and [Pasted ~3 lines #3]", [first, second, third])).toBe("d\ne\nf then a\nb\nc and g\nh\ni")
})

test("expanding replaces tokens verbatim in one pass", () => {
  const parts = [{ token: "[Pasted ~3 lines]", text: "cost $& and $1 [Pasted ~4 lines]\n\n" }, { token: "[Pasted ~4 lines]", text: "never inserted twice" }]
  expect(expandPasted("see [Pasted ~3 lines] now", parts)).toBe("see cost $& and $1 [Pasted ~4 lines]\n\n now")
  expect(expandPasted("a token you deleted [Pasted ~4 lines", parts)).toBe("a token you deleted [Pasted ~4 lines")
  expect(expandPasted("no tokens", [])).toBe("no tokens")
})

test("appending a snapshot renames clashing tokens and keeps images", () => {
  const image = { data: "x", mimeType: "image/png" }
  const base = { text: "draft [Pasted ~3 lines]", pasted: [{ token: "[Pasted ~3 lines]", text: "a\nb\nc" }], images: [] }
  const next = { text: "stashed [Pasted ~3 lines]", pasted: [{ token: "[Pasted ~3 lines]", text: "d\ne\nf" }], images: [image] }
  const joined = appendSnapshot(base, next)
  expect(joined.text).toBe("draft [Pasted ~3 lines]\n\nstashed [Pasted ~3 lines #2]")
  expect(joined.images).toEqual([image])
  expect(expandPasted(joined.text, joined.pasted)).toBe("draft a\nb\nc\n\nstashed d\ne\nf")
  const empty = { text: "", pasted: [], images: [] }
  expect(appendSnapshot(empty, next)).toBe(next)
})

test("restoring several pasted blocks onto a draft that has one keeps every block's text", () => {
  const first = "[Pasted ~3 lines]"
  const second = "[Pasted ~3 lines #2]"
  const base = { text: first, pasted: [{ token: first, text: "A\nA\nA" }], images: [] }
  const next = { text: `${first} then ${second}`, pasted: [{ token: first, text: "B\nB\nB" }, { token: second, text: "C\nC\nC" }], images: [] }
  const joined = appendSnapshot(base, next)
  expect(new Set(joined.pasted.map((part) => part.token)).size).toBe(3)
  expect(expandPasted(joined.text, joined.pasted)).toBe("A\nA\nA\n\nB\nB\nB then C\nC\nC")
})
