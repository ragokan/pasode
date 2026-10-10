import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { PaseoAgent } from "../src/paseo"
import { loadPlugins } from "../src/plugin"
import { Sidebar, sidebarFeatures } from "../src/sidebar"

test("built-in features fill the sidebar in slot order and replace the default footer", async () => {
  const agent = {
    id: "a", title: "Fixture", status: "idle", cwd: "/tmp/x", provider: "claude", pendingPermissions: [],
    lastUsage: { contextWindowUsedTokens: 12_345, contextWindowMaxTokens: 100_000, totalCostUsd: 1.5 },
  } as unknown as PaseoAgent
  const screen = await testRender(() => {
    void loadPlugins(useRenderer(), sidebarFeatures)
    return <Sidebar agent={agent} />
  }, { width: 40, height: 30 })
  await screen.renderOnce()
  const frame = screen.captureCharFrame()
  screen.renderer.destroy()

  expect(frame).toContain("12,345 tokens")
  expect(frame).toContain("12% used")
  expect(frame).toContain("$1.50 spent")
  expect(frame.indexOf("Context")).toBeLessThan(frame.indexOf("Speed"))
  expect(frame).toMatch(/• Paseo — \w+/)
})
