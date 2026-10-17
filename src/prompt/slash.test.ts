import { expect, test } from "bun:test"
import { offsetWidth, renameArgument, slashTrigger } from "./slash"

test("a typed /rename with a name is ours, not the provider's", () => {
  expect(renameArgument("/rename Fix login ")).toBe("Fix login")
  expect(renameArgument("/rename")).toBeUndefined()
  expect(renameArgument("/renamed x")).toBeUndefined()
  expect(renameArgument("please /rename x")).toBeUndefined()
})

test("slash completion triggers at the start or after whitespace, mid-text included", () => {
  expect(slashTrigger("/rev")).toEqual({ index: 0, query: "rev" })
  expect(slashTrigger("please use /che")).toEqual({ index: 11, query: "che" })
  expect(slashTrigger("line one\n/")).toEqual({ index: 9, query: "" })
  expect(slashTrigger("see src/foo")).toBeUndefined()
  expect(slashTrigger("/review now")).toBeUndefined()
  expect(slashTrigger("/a/b")).toBeUndefined()
  expect(slashTrigger("plain text")).toBeUndefined()
})

test("offsets count display width like the textarea", () => {
  expect(offsetWidth("ab\ncd")).toBe(5)
  expect(offsetWidth("日本 /x")).toBe(7)
})
