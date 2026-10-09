import { expect, test } from "bun:test"
import { shellTransition } from "./mode"

test("bang enters shell mode only from an empty normal prompt", () => {
  expect(shellTransition("normal", "", "!")).toBe("shell")
  expect(shellTransition("normal", "text", "!")).toBeUndefined()
  expect(shellTransition("normal", " ", "!")).toBeUndefined()
  expect(shellTransition("shell", "", "!")).toBeUndefined()
  expect(shellTransition("normal", "", "a")).toBeUndefined()
})

test("backspace exits shell mode only when the prompt is empty", () => {
  expect(shellTransition("shell", "", "backspace")).toBe("normal")
  expect(shellTransition("shell", "pwd", "backspace")).toBeUndefined()
  expect(shellTransition("normal", "", "backspace")).toBeUndefined()
})
