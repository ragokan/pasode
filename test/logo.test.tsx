import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Logo } from "../src/logo"

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
