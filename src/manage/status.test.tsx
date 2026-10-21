import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { dialog, DialogHost } from "../dialog"
import { daemon } from "../paseo"
import { setToast, toast } from "../state"
import { configSummary, statusDialog } from "./status"

let screen: TestRendererSetup | undefined
const mocks: { mockRestore(): void }[] = []
afterEach(() => {
  dialog.clear() // the dialog state is global; a left-open one swallows later tests' keys
  screen?.renderer.destroy()
  screen = undefined
  while (mocks.length) mocks.pop()!.mockRestore()
  setToast(undefined)
})

const open = async () => {
  screen = await testRender(() => <DialogHost />, { width: 100, height: 30 })
  void statusDialog("Daemon     host · Paseo 0.12.0")
  await screen.renderOnce()
}

test("the daemon config summary shows flags, counts and provider names only", () => {
  expect(configSummary(undefined)).toBe("—")
  expect(
    configSummary({
      mcp: { enabled: true, injectIntoAgents: true },
      pluginsEnabled: true,
      relay: { enabled: false },
      browserTools: { enabled: false },
      agentProfiles: [{}, {}],
      providers: { claude: { env: { ANTHROPIC_API_KEY: "sk-secret" } }, codex: {} },
    } as never),
  ).toBe("MCP on (injected) · plugins on · relay off · browser tools off · 2 profiles · providers claude, codex")
})

test("/status keeps its text and offers diagnostics, restart and update", async () => {
  await open()
  const frame = screen!.captureCharFrame()
  expect(frame).toContain("Daemon     host · Paseo 0.12.0")
  expect(frame).toContain("[d] provider diagnostics · [r] restart daemon · [u] update daemon")
})

test("diagnostics run on demand for the chosen provider", async () => {
  const diagnostic = spyOn(daemon, "getProviderDiagnostic").mockResolvedValue({ requestId: "r", provider: "claude", diagnostic: "Claude Code\n  Version: 2.1.306\n  Status: Ready" } as never)
  mocks.push(diagnostic)
  await open()
  expect(diagnostic).not.toHaveBeenCalled()
  screen!.mockInput.pressKey("d")
  await screen!.renderOnce()
  expect(screen!.captureCharFrame()).toContain("Provider diagnostics")
  screen!.mockInput.pressEnter() // Claude Code
  await Bun.sleep(0)
  await screen!.renderOnce()
  expect(diagnostic).toHaveBeenCalledWith("claude")
  expect(screen!.captureCharFrame()).toContain("Version: 2.1.306")
})

test("a failed diagnostic shows its error in the dialog instead of throwing", async () => {
  mocks.push(spyOn(daemon, "getProviderDiagnostic").mockRejectedValue(new Error("Transport not connected")))
  await open()
  screen!.mockInput.pressKey("d")
  await screen!.renderOnce()
  screen!.mockInput.pressEnter() // Claude Code
  await Bun.sleep(0)
  await screen!.renderOnce()
  const frame = screen!.captureCharFrame()
  expect(frame).toContain("Claude Code diagnostics")
  expect(frame).toContain("Transport not connected")
})

test("restart and update ask first, and Cancel does nothing", async () => {
  const restart = spyOn(daemon, "restartServer").mockResolvedValue({ status: "restart_requested", requestId: "r", clientId: "c" } as never)
  const update = spyOn(daemon, "updateDaemon").mockResolvedValue({ requestId: "r", success: true, error: null, previousVersion: "0.12.0", newVersion: "0.13.0" })
  mocks.push(spyOn(daemon, "getLastServerInfoMessage").mockReturnValue({ version: "0.12.0" } as never), restart, update)
  await open()
  screen!.mockInput.pressKey("r")
  await screen!.renderOnce()
  expect(screen!.captureCharFrame()).toContain("Restarts the Paseo daemon")
  screen!.mockInput.pressArrow("left") // Cancel
  screen!.mockInput.pressEnter()
  await Bun.sleep(0)
  expect(restart).not.toHaveBeenCalled()

  screen!.renderer.destroy()
  await open()
  screen!.mockInput.pressKey("r")
  await screen!.renderOnce()
  screen!.mockInput.pressEnter() // Restart
  await Bun.sleep(0)
  expect(restart).toHaveBeenCalledTimes(1)
  expect(toast()).toMatchObject({ variant: "warning", message: expect.stringContaining("restarting") })

  screen!.renderer.destroy()
  await open()
  screen!.mockInput.pressKey("u")
  await screen!.renderOnce()
  const frame = screen!.captureCharFrame()
  expect(frame).toContain("Installs the latest Paseo release")
  expect(frame).toContain("now 0.12.0")
  expect(update).not.toHaveBeenCalled()
  screen!.mockInput.pressEnter() // Update
  await Bun.sleep(0)
  expect(update).toHaveBeenCalledTimes(1)
  expect(toast()).toMatchObject({ variant: "success", message: "Daemon updated 0.12.0 → 0.13.0; it is restarting" })
})
