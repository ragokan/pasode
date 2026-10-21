import { expect, test } from "bun:test"
import { mentionTrigger, quoteMention } from "./mention"

test("@ completes at the start or after a non-word character, not inside an email address", () => {
  expect(mentionTrigger("@src/ap")).toEqual({ index: 0, query: "src/ap" })
  expect(mentionTrigger("look at @")).toEqual({ index: 8, query: "" })
  expect(mentionTrigger("see (@app")).toEqual({ index: 5, query: "app" })
  expect(mentionTrigger("line\n@x")).toEqual({ index: 5, query: "x" })
  expect(mentionTrigger("mail me@host")).toBeUndefined()
  expect(mentionTrigger("@src/app.ts and")).toBeUndefined() // the query ended at the space
  expect(mentionTrigger('say "@x')).toEqual({ index: 5, query: "x" })
  expect(mentionTrigger("@a'b")).toBeUndefined()
  expect(mentionTrigger("no mention")).toBeUndefined()
})

test("the chosen path goes in as double-quoted text", () => {
  expect(quoteMention("src/app.tsx")).toBe('"src/app.tsx"')
  expect(quoteMention("my docs/a b.md")).toBe('"my docs/a b.md"')
  expect(quoteMention('odd"name')).toBe('"odd\\"name"')
})
