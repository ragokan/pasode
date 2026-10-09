import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { kvGet } from "../src/config"
import { DialogSettings, nextValue, settingLabel, settings } from "../src/settings"
import { prefs } from "../src/state"

let screen: TestRendererSetup | undefined
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
})

test("every setting is a real pref with a valid current value", () => {
  for (const setting of settings) {
    expect(setting.key in prefs).toBe(true)
    if (setting.values) expect(setting.values).toContain(prefs[setting.key])
  }
  expect(nextValue(["low", "medium", "high"], "high", 1)).toBe("low")
  expect(nextValue(["low", "medium", "high"], "low", -1)).toBe("high")
  expect(settingLabel(settings.find((s) => s.key === "newLocation")!, "inherit")).toBe("active session")
})

test("settings dialog lists OpenCode's categories and ←/→ changes the selected value, persisted", async () => {
  screen = await testRender(() => <DialogSettings />, { width: 90, height: 60 })
  await screen.renderOnce()
  let frame = screen.captureCharFrame()
  for (const text of ["Settings", "Appearance", "Color mode", "Session", "Tool grouping", "Verbosity", "Transcript images", "Permissions", "Diffs", "←/→ change"]) expect(frame).toContain(text)
  expect(frame).toMatch(/Tool grouping\s+auto/)
  expect(frame).toMatch(/Permissions\s+bypass/)

  const row = settings.findIndex((setting) => setting.key === "grouping")
  for (let i = 0; i < row; i++) screen.mockInput.pressArrow("down")
  screen.mockInput.pressArrow("right")
  await screen.renderOnce()
  expect(prefs.grouping).toBe("none")
  expect(screen.captureCharFrame()).toMatch(/Tool grouping\s+none/)
  expect(kvGet<{ grouping?: string }>("prefs", {}).grouping).toBe("none")

  screen.mockInput.pressArrow("left")
  await screen.renderOnce()
  expect(prefs.grouping).toBe("auto")
})
