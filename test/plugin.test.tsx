import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { loadPlugins, Slot, type PasodePlugin } from "../src/plugin"

test("a loaded plugin's slots go away with the scope that loaded it", async () => {
  const feature: PasodePlugin = { id: "slot-owner", setup: (ctx) => void onCleanup(ctx.ui.slot("sidebar_content", () => <text>plugin slot</text>)) }
  let dispose!: () => void
  createRoot((done) => {
    dispose = done
    void loadPlugins({} as never, [feature])
  })
  const screen = await testRender(() => <Slot name="sidebar_content" />, { width: 30, height: 4 })
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("plugin slot")
  dispose()
  await screen.renderOnce()
  expect(screen.captureCharFrame()).not.toContain("plugin slot")
  screen.renderer.destroy()
})
