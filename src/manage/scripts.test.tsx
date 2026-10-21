import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { dialog, DialogHost } from "../dialog"
import { api, daemon, setAgents, type PaseoAgent } from "../paseo"
import { setAgentId, setToast, toast } from "../state"
import { openScripts, scriptRow, setupLabel } from "./scripts"

let screen: TestRendererSetup | undefined
const mocks: { mockRestore(): void }[] = []
afterEach(() => {
  dialog.clear() // the dialog state is global; a left-open one swallows later tests' keys
  screen?.renderer.destroy()
  screen = undefined
  while (mocks.length) mocks.pop()!.mockRestore()
  setAgentId(undefined)
  setToast(undefined)
})

const script = (name: string, extra: Record<string, unknown> = {}) =>
  ({ scriptName: name, type: "service", hostname: `${name}.localhost`, port: null, proxyUrl: null, lifecycle: "stopped", health: null, exitCode: null, terminalId: null, ...extra }) as never

test("a script row shows lifecycle, health, and where it listens", () => {
  expect(scriptRow(script("web"))).toMatchObject({ state: "stopped", description: "service", tone: "muted" })
  expect(scriptRow(script("web", { lifecycle: "running", health: "healthy", port: 3000, localProxyUrl: "http://web.localhost:6767" }))).toMatchObject({
    state: "running · healthy",
    description: "service · http://web.localhost:6767",
    tone: "success",
  })
  expect(scriptRow(script("web", { lifecycle: "running", health: "unhealthy", port: 3000 }))).toMatchObject({ description: "service · :3000", tone: "warning" })
  expect(scriptRow(script("build", { type: "script", exitCode: 2 }))).toMatchObject({ state: "exited 2", description: undefined, tone: "error" })
})

test("setup progress counts finished commands", () => {
  const setup = (status: string, commands: string[]) => ({ status, detail: { commands: commands.map((state) => ({ status: state })) } }) as never
  expect(setupLabel(undefined)).toBeUndefined()
  expect(setupLabel(null)).toBeUndefined()
  expect(setupLabel(setup("running", ["completed", "running", "running"]))).toBe("setup running 1/3")
  expect(setupLabel(setup("completed", []))).toBe("setup done")
  expect(setupLabel(setup("failed", []))).toBe("setup failed")
})

test("/scripts lists the session workspace's scripts live; enter starts, x stops, the setup row runs setup", async () => {
  const observers: { update(message: unknown): void; snapshot(): void }[] = []
  const released: string[] = []
  mocks.push(
    spyOn(api, "observeEvents").mockImplementation((() => ({
      subscribe: (observer: (typeof observers)[number]) => (observers.push(observer), () => released.push("unsubscribed")),
      release: async () => void released.push("released"),
    })) as never),
    spyOn(daemon, "listWorkspaceScripts").mockResolvedValue({ requestId: "r", workspaceId: "w1", scripts: [script("web"), script("api", { lifecycle: "running", health: "healthy", port: 4000, terminalId: "t1" })], error: null }),
    spyOn(daemon, "fetchWorkspaceSetupStatus").mockResolvedValue({ requestId: "r", workspaceId: "w1", snapshot: { status: "completed", detail: { type: "worktree_setup", worktreePath: "/x", branchName: "b", log: "", commands: [] }, error: null } } as never),
  )
  const started = spyOn(daemon, "startWorkspaceScript").mockResolvedValue({ requestId: "r", workspaceId: "w1", scriptName: "web", terminalId: "t2", error: null })
  const stopped = spyOn(daemon, "stopWorkspaceScript").mockResolvedValue({ requestId: "r", workspaceId: "w1", scriptName: "api", script: null, error: null } as never)
  const setup = spyOn(daemon, "runWorkspaceSetup").mockResolvedValue({ requestId: "r", workspaceId: "w1", started: true, error: null })
  mocks.push(started, stopped, setup)
  setAgents({ a: { id: "a", workspaceId: "w1", title: "A", provider: "claude", cwd: "/x" } as PaseoAgent })
  setAgentId("a")

  screen = await testRender(() => <DialogHost />, { width: 100, height: 30 })
  openScripts()
  await Bun.sleep(0)
  await screen.renderOnce()
  let frame = screen.captureCharFrame()
  expect(frame).toContain("Scripts")
  expect(frame).toMatch(/Run workspace setup\s+setup done/)
  expect(frame).toMatch(/web\s+service\s+stopped/)
  expect(frame).toMatch(/api\s+service · :4000\s+running · healthy/)

  // script_status_update for this workspace replaces the list; other workspaces' updates are ignored.
  observers[0]!.update({ type: "script_status_update", payload: { workspaceId: "w2", scripts: [] } })
  observers[0]!.update({ type: "script_status_update", payload: { workspaceId: "w1", scripts: [script("web", { lifecycle: "running", health: "unhealthy", port: 3000 })] } })
  await screen.renderOnce()
  frame = screen.captureCharFrame()
  expect(frame).toMatch(/web\s+service · :3000\s+running · unhealthy/)
  expect(frame).not.toContain("api")
  observers[0]!.update({ type: "workspace_setup_progress", payload: { workspaceId: "w1", status: "running", error: null, detail: { type: "worktree_setup", worktreePath: "/x", branchName: "b", log: "", commands: [{ index: 0, command: "bun i", cwd: "/x", status: "running", exitCode: null }] } } })
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toMatch(/Run workspace setup\s+setup running 0\/1/)

  observers[0]!.update({ type: "script_status_update", payload: { workspaceId: "w1", scripts: [script("web"), script("api", { lifecycle: "running", port: 4000, terminalId: "t1" })] } })
  await screen.renderOnce()
  screen.mockInput.pressArrow("down") // web
  screen.mockInput.pressEnter()
  await Bun.sleep(0)
  expect(started).toHaveBeenCalledWith("w1", "web")
  expect(toast()?.message).toBe("Started web")

  await screen.renderOnce()
  screen.mockInput.pressArrow("down") // api
  screen.mockInput.pressKey("x")
  await Bun.sleep(0)
  expect(stopped).toHaveBeenCalledWith("w1", "api")

  screen.mockInput.pressArrow("up")
  screen.mockInput.pressArrow("up")
  screen.mockInput.pressEnter() // the setup row
  await Bun.sleep(0)
  expect(setup).toHaveBeenCalledWith("w1")
})

test("without a session there is no workspace to list", () => {
  openScripts()
  expect(toast()?.message).toContain("Open a session first")
})
