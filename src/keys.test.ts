import { expect, test } from "bun:test"
import { createKeymap, formatBinding, parseBinding } from "./keys"

const key = (name: string, mods: Partial<Record<"ctrl" | "shift" | "meta" | "super", boolean>> = {}) => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  super: false,
  ...mods,
})

test("parses OpenCode keybind strings", () => {
  expect(parseBinding("none")).toEqual([])
  expect(parseBinding("shift+return,ctrl+j")).toEqual([[key("return", { shift: true })], [key("j", { ctrl: true })]])
  expect(parseBinding("<leader>l", "ctrl+x")).toEqual([[key("x", { ctrl: true }), key("l")]])
  expect(parseBinding("esc esc")).toEqual([[key("escape"), key("escape")]])
  expect(parseBinding("control+x,ctl+x <leader>y,alt+x")).toEqual([[key("x", { meta: true })]])
  expect(formatBinding("<leader>l,ctrl+k")).toBe("ctrl+x l")
  expect(formatBinding("down")).toBe("↓")
  expect(formatBinding("<leader>up")).toBe("ctrl+x ↑")
  expect(formatBinding("meta+pagedown")).toBe("alt+pgdn")
})

test("matches sequences with pending prefixes", () => {
  const keymap = createKeymap(() => [
    { id: "sessions", sequences: parseBinding("<leader>l") },
    { id: "palette", sequences: parseBinding("ctrl+p") },
    { id: "sidebar", sequences: parseBinding("ctrl+b") },
  ])
  expect(keymap.feed(key("p", { ctrl: true }))).toBe("palette")
  expect(keymap.feed(key("x", { ctrl: true }))).toBe("pending")
  expect(keymap.pending).toBe(true)
  expect(keymap.feed(key("l"))).toBe("sessions")
  expect(keymap.feed(key("x", { ctrl: true }))).toBe("pending")
  expect(keymap.feed(key("z"))).toBeUndefined()
  expect(keymap.pending).toBe(false)
  expect(keymap.feed(key("a"))).toBeUndefined()
})

test("punctuation strokes: `.` and `,` bind, and a trailing comma is the key, not a separator", () => {
  expect(parseBinding("<leader>.")).toEqual([[key("x", { ctrl: true }), key(".")]])
  expect(parseBinding("<leader>,")).toEqual([[key("x", { ctrl: true }), key(",")]])
  expect(parseBinding("<leader>1,ctrl+1")).toEqual([[key("x", { ctrl: true }), key("1")], [key("1", { ctrl: true })]])
  expect(parseBinding("<leader>,,ctrl+k")).toEqual([[key("x", { ctrl: true }), key(",")], [key("k", { ctrl: true })]])
  expect(parseBinding("ctrl+k,<leader>,")).toEqual([[key("k", { ctrl: true })], [key("x", { ctrl: true }), key(",")]])
  expect(formatBinding("<leader>,")).toBe("ctrl+x ,")
  expect(formatBinding("<leader>.,ctrl+k")).toBe("ctrl+x .")
  const keymap = createKeymap(() => [{ id: "previous", sequences: parseBinding("<leader>,") }])
  keymap.feed(key("x", { ctrl: true }))
  expect(keymap.feed(key(","))).toBe("previous")
})
