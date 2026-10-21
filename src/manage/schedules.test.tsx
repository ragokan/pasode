import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { dialog, dialogs, DialogHost } from "../dialog"
import { daemon, setAgents, type PaseoAgent } from "../paseo"
import { setAgentId, setDraft, setToast, toast } from "../state"
import { cadenceLabel, createSchedule, newAgentConfig, openSchedules, scheduleDetails } from "./schedules"

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

const AGENT = "11111111-1111-4111-8111-111111111111"
const session = { id: AGENT, title: "Fix bug", provider: "claude", cwd: "/work/app", model: "claude-opus-5-5", currentModeId: "plan", thinkingOptionId: "high" } as PaseoAgent
const schedule = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: null, prompt: "Check the deps", status: "active", cadence: { type: "cron", expression: "0 9 * * 1-5" }, target: { type: "new-agent", config: { provider: "claude", cwd: "/work/app" } }, nextRunAt: "2026-10-22T09:00:00.000Z", lastRunAt: null, pausedAt: null, expiresAt: null, maxRuns: null, createdAt: "", updatedAt: "", ...extra }) as never

/** dialogs.prompt answers in order; the descriptions it was asked with are recorded. */
function answers(...values: (string | undefined)[]) {
  const asked: (string | undefined)[] = []
  mocks.push(spyOn(dialogs, "prompt").mockImplementation((async (options: { description?: string }) => (asked.push(options.description), values.shift())) as never))
  return asked
}

test("cadences read like the cron they are, or an exact interval", () => {
  expect(cadenceLabel({ type: "cron", expression: "*/5 * * * *" })).toBe("*/5 * * * *")
  expect(cadenceLabel({ type: "every", everyMs: 7_200_000 })).toBe("every 2h")
  expect(cadenceLabel({ type: "every", everyMs: 5_400_000 })).toBe("every 90m")
  expect(cadenceLabel({ type: "every", everyMs: 30_000 })).toBe("every 30s")
})

test("details show cadence, target and recent runs, newest first", () => {
  setAgents({ [AGENT]: session })
  const text = scheduleDetails(schedule("s1", { target: { type: "agent", agentId: AGENT }, cadence: { type: "cron", expression: "0 9 * * *", timezone: "Europe/Istanbul" } }), [
    { id: "r1", scheduledFor: "", startedAt: "2026-10-20T09:00:00.000Z", endedAt: null, status: "succeeded", agentId: null, output: null, error: null },
    { id: "r2", scheduledFor: "", startedAt: "2026-10-21T09:00:00.000Z", endedAt: null, status: "failed", agentId: null, output: null, error: "provider offline" },
  ])
  expect(text).toContain("Cadence  0 9 * * * (Europe/Istanbul)")
  expect(text).toContain("Target   heartbeat to Fix bug")
  expect(text).toContain("Prompt\n  Check the deps")
  expect(text.indexOf("failed · provider offline")).toBeGreaterThan(0)
  expect(text.indexOf("failed")).toBeLessThan(text.indexOf("succeeded"))
})

test("a new schedule runs a session like the open one (or the home draft)", () => {
  setAgents({ [AGENT]: session })
  setAgentId(AGENT)
  expect(newAgentConfig()).toEqual({ provider: "claude", cwd: "/work/app", model: "claude-opus-5-5", modeId: "plan", thinkingOptionId: "high" })
  setAgentId(undefined)
  setDraft({ provider: "codex", model: "gpt-5", thinking: "low", cwd: "/home/me" })
  expect(newAgentConfig()).toEqual({ provider: "codex", cwd: "/home/me", model: "gpt-5", modeId: "full-access", thinkingOptionId: "low" })
})

test("a heartbeat targets the open session; an invalid cron is rejected before anything is sent and asked again", async () => {
  setAgents({ [AGENT]: session })
  setAgentId(AGENT)
  const asked = answers("Run the tests", "every day", "0 9 * 1-5", "0 9 * * 1-5", "")
  const create = spyOn(daemon, "scheduleCreate").mockResolvedValue({ requestId: "r", schedule: schedule("s1", { name: null }), error: null })
  mocks.push(create)
  await createSchedule("heartbeat")
  expect(asked[2]).toBe("Cron expressions must have 5 fields") // the daemon's own validator's message
  expect(asked[3]).toBe("Cron expressions must have 5 fields")
  expect(create).toHaveBeenCalledTimes(1)
  expect(create.mock.calls[0]![0]).toEqual({
    prompt: "Run the tests",
    name: undefined,
    cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    target: { type: "self", agentId: AGENT },
  })
  expect(toast()).toMatchObject({ variant: "success", message: expect.stringContaining("Heartbeat created") })
})

test("a new schedule sends the session config and name; the daemon's error is shown; Escape sends nothing", async () => {
  setAgents({ [AGENT]: session })
  setAgentId(AGENT)
  answers("Nightly audit", "0 2 * * *", " Audit ")
  const create = spyOn(daemon, "scheduleCreate").mockResolvedValue({ requestId: "r", schedule: null, error: "Schedule limit reached" })
  mocks.push(create)
  await createSchedule("new")
  expect(create.mock.calls[0]![0]).toMatchObject({ name: "Audit", target: { type: "new-agent", config: { provider: "claude", cwd: "/work/app", model: "claude-opus-5-5" } } })
  expect(toast()).toMatchObject({ variant: "error", message: "Schedule limit reached" })

  create.mockClear()
  answers("Nightly audit", undefined)
  await createSchedule("new")
  expect(create).not.toHaveBeenCalled()
})

test("/schedules lists heartbeats and schedules; p pauses, r runs once, d deletes after a confirm", async () => {
  setAgents({ [AGENT]: session })
  setAgentId(AGENT)
  let list = [schedule("s1", { name: "Nightly audit" }), schedule("s2", { name: null, prompt: "Ping", target: { type: "agent", agentId: AGENT }, status: "paused" })]
  mocks.push(spyOn(daemon, "scheduleList").mockImplementation(async () => ({ requestId: "r", schedules: list }) as never))
  const pause = spyOn(daemon, "schedulePause").mockResolvedValue({ requestId: "r", schedule: null, error: null } as never)
  const resume = spyOn(daemon, "scheduleResume").mockResolvedValue({ requestId: "r", schedule: null, error: null } as never)
  const run = spyOn(daemon, "scheduleRunOnce").mockResolvedValue({ requestId: "r", schedule: null, error: null } as never)
  const remove = spyOn(daemon, "scheduleDelete").mockResolvedValue({ requestId: "r", scheduleId: "s1", error: null })
  mocks.push(pause, resume, run, remove)

  screen = await testRender(() => <DialogHost />, { width: 100, height: 40 })
  openSchedules()
  await Bun.sleep(0)
  await screen.renderOnce()
  const frame = screen.captureCharFrame()
  expect(frame).toMatch(/Heartbeats\s*\n.*Ping\s+0 9 \* \* 1-5\s+paused/)
  expect(frame).toMatch(/Schedules\s*\n.*Nightly audit\s+0 9 \* \* 1-5\s+active/)
  expect(frame).toContain("pause/resume p")

  // Rows: New schedule, Heartbeat this session (a session is open), then the heartbeat, then the schedule.
  for (let i = 0; i < 2; i++) screen.mockInput.pressArrow("down")
  screen.mockInput.pressKey("p") // Ping is paused → resume
  await Bun.sleep(0)
  expect(resume).toHaveBeenCalledWith({ id: "s2" })
  screen.mockInput.pressArrow("down")
  screen.mockInput.pressKey("p")
  screen.mockInput.pressKey("r")
  await Bun.sleep(0)
  expect(pause).toHaveBeenCalledWith({ id: "s1" })
  expect(run).toHaveBeenCalledWith({ id: "s1" })

  screen.mockInput.pressKey("d")
  await Bun.sleep(0)
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain('Delete "Nightly audit"?')
  expect(remove).not.toHaveBeenCalled()
  list = [list[1]!]
  screen.mockInput.pressEnter() // Delete (default)
  await Bun.sleep(5)
  expect(remove).toHaveBeenCalledWith({ id: "s1" })
  await screen.renderOnce()
  // Back on the refreshed list.
  expect(screen.captureCharFrame()).not.toContain("Nightly audit")
})
