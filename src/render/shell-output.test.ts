import { expect, test } from "bun:test"
import { collapseShellOutput } from "./shell-output"

test("shell preview budgets command/spacing and keeps the output tail", () => {
  const output = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n")
  const collapsed = collapseShellOutput("$ command", output, 10, 800)
  expect(collapsed.input).toBe("$ command")
  expect(collapsed.output).toBe("(8 earlier lines)\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15")
  expect(collapsed.overflow).toBe(true)
})

test("long commands are restricted to two display lines without splitting graphemes", () => {
  expect(collapseShellOutput("😀".repeat(20), "", 10, 80)).toEqual({ input: "😀".repeat(7) + "…", output: "", overflow: true })
  expect(collapseShellOutput("one\ntwo\nthree", "", 10, 800)).toEqual({ input: "one\ntwo…", output: "", overflow: true })
})

test("empty/short output does not collapse; output-only previews use the tail", () => {
  expect(collapseShellOutput("$ pwd", "/work", 10, 800)).toEqual({ input: "$ pwd", output: "/work", overflow: false })
  expect(collapseShellOutput("", "a\nb\nc", 2, 80)).toEqual({ input: "", output: "(2 earlier lines)\nc", overflow: true })
})
