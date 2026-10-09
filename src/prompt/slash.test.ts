import { expect, test } from "bun:test"
import { offsetWidth, slashTrigger } from "./slash"

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
