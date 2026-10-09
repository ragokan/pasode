import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { Composer, composerOpen, handleComposerKey, runningSubagents, toggleComposer } from "../src/composer"
import { setAgents, type PaseoAgent } from "../src/paseo"
import { setAgentId } from "../src/state"

let screen: TestRendererSetup | undefined
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
})

const agent = (id: string, status: string, labels: Record<string, string> = {}) =>
  ({ id, title: `Session ${id}`, status, labels, cwd: "/tmp/x", provider: "claude", pendingPermissions: [] }) as unknown as PaseoAgent
const key = (name: string, ctrl = false) => ({ name, ctrl, shift: false, meta: false }) as Parameters<typeof handleComposerKey>[0]

test("↓ composer lists running child sessions, switches tabs, toggles finished, and closes like OpenCode's", async () => {
  setAgents({
    parent: agent("parent", "idle"),
    a: agent("a", "running", { "paseo.parent-agent-id": "parent" }),
    b: agent("b", "idle", { "paseo.parent-agent-id": "parent" }),
  })
  setAgentId("parent")
  expect(runningSubagents()).toBe(1)
  screen = await testRender(() => <Composer />, { width: 80, height: 14 })
  toggleComposer()
  await screen.renderOnce()
  let frame = screen.captureCharFrame()
  expect(frame).toContain("Subagents  Shell")
  expect(frame).toContain("Agent · Session a")
  expect(frame).not.toContain("Session b")
  expect(frame).toContain("enter open  ctrl+d interrupt  ctrl+a finished")

  handleComposerKey(key("a", true))
  await screen.renderOnce()
  frame = screen.captureCharFrame()
  expect(frame).toContain("Agent · Session b")
  expect(frame).not.toContain("Session a ")

  handleComposerKey(key("right"))
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("No shells in this directory")

  expect(handleComposerKey(key("escape"))).toBe(true)
  expect(composerOpen()).toBe(false)
  expect(handleComposerKey(key("escape"))).toBe(false)
})
