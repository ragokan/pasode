import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Logo, sessionEpilogue } from "../src/logo"

test("logo renders pas|ode side by side, like OpenCode's open|code", async () => {
  const { captureCharFrame, renderOnce, renderer } = await testRender(() => <Logo />, { width: 60, height: 20 })
  await renderOnce()
  const lines = captureCharFrame().split("\n").filter((line) => line.trim()).map((line) => line.trimEnd())
  expect(lines).toEqual([
    "                       ▄",
    "█▀▀█ ▀▀▀█ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
    "█  █ █▀▀█ ▀▀▀█ █  █ █  █ █▀▀▀",
    "█▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  ])
  renderer.destroy()
})

test("logo hides on short terminals and stacks on narrow ones", async () => {
  const short = await testRender(() => <Logo />, { width: 60, height: 10 })
  await short.renderOnce()
  expect(short.captureCharFrame().trim()).toBe("")
  const narrow = await testRender(() => <Logo />, { width: 30, height: 20 })
  await narrow.renderOnce()
  expect(narrow.captureCharFrame().split("\n").filter((line) => line.trim()).length).toBe(7)
  short.renderer.destroy()
  narrow.renderer.destroy()
})

test("exit epilogue: wordmark, session title and the continue command, like OpenCode's", () => {
  const plain = sessionEpilogue({ title: "Quick System Status Check", id: "3c6e5cde-86d4" }).replace(/\x1b\[[0-9;]*m/g, "")
  const lines = plain.split("\n")
  expect(lines.slice(1, 4).every((line) => line.includes("█"))).toBe(true)
  expect(lines).toContain("  Session   Quick System Status Check")
  expect(lines).toContain("  Continue  pasode -s 3c6e5cde-86d4")
})
