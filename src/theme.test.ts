import { expect, jest, test } from "bun:test"
import { applyTheme, syntax, theme } from "./theme"

test("applying a theme frees the previous native syntax style once renderables have switched", () => {
  jest.useFakeTimers()
  try {
    const first = syntax()
    applyTheme({ ...theme })
    const second = syntax()
    expect(second).not.toBe(first)
    expect(() => first.getRegisteredNames()).not.toThrow()
    jest.advanceTimersByTime(2000)
    expect(() => first.getRegisteredNames()).toThrow("destroyed")
    expect(() => second.getRegisteredNames()).not.toThrow()
  } finally {
    jest.useRealTimers()
  }
})
