// Paseo schedules and heartbeats. A heartbeat is a schedule whose target is a session (`agent`/`self`) instead of a new
// one per run; the daemon runs both on a cron cadence, so they keep firing after pasode exits.
import { validateCronExpression } from "@getpaseo/protocol/schedule/cron-expression"
import type { KeyEvent } from "@opentui/core"
import { createMemo, createSignal, onCleanup } from "solid-js"
import { agentConfig } from "../actions"
import { dialog, dialogs, DialogSelect, truncate } from "../dialog"
import { agents, daemon, sessionTitle } from "../paseo"
import { current, draft, notify, showError } from "../state"
import { theme } from "../theme"

type Schedule = Awaited<ReturnType<typeof daemon.scheduleList>>["schedules"][number]
type Run = Awaited<ReturnType<typeof daemon.scheduleLogs>>["runs"][number]

const units = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"], [1000, "s"]] as const

/** "0 9 * * 1-5", or "every 2h" for the interval cadences other clients create. */
export function cadenceLabel(cadence: Schedule["cadence"]) {
  if (cadence.type === "cron") return cadence.expression
  const [size, unit] = units.find(([size]) => cadence.everyMs % size === 0) ?? [1, "ms"]
  return `every ${cadence.everyMs / size}${unit}`
}

export const scheduleName = (schedule: Schedule) => schedule.name || truncate(schedule.prompt, 40)

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—")

export function scheduleDetails(schedule: Schedule, runs: Run[]) {
  const { target, cadence } = schedule
  const where =
    target.type === "new-agent"
      ? `new ${target.config.provider} session in ${target.config.cwd}`
      : `heartbeat to ${agents[target.agentId] ? sessionTitle(agents[target.agentId]!) : target.agentId}`
  const recent = runs
    .toSorted((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, 8)
    .map((run) => `  ${when(run.startedAt)}  ${run.status}${run.error ? ` · ${truncate(run.error, 60)}` : ""}`)
  return [
    `Status   ${schedule.status}${schedule.status === "active" ? ` · next ${when(schedule.nextRunAt)}` : ""}`,
    `Cadence  ${cadenceLabel(cadence)}${cadence.type === "cron" && cadence.timezone ? ` (${cadence.timezone})` : ""}`,
    `Target   ${where}`,
    `Last run ${when(schedule.lastRunAt)}${schedule.maxRuns ? ` · max ${schedule.maxRuns} runs` : ""}`,
    `Prompt\n  ${schedule.prompt.trim().replace(/\n/g, "\n  ")}`,
    `Runs\n${recent.join("\n") || "  none yet"}`,
  ].join("\n")
}

/** The session a new schedule would start: the open one's settings, else the home screen's draft. */
export function newAgentConfig() {
  const agent = current()
  if (agent) {
    return {
      provider: agent.provider,
      cwd: agent.cwd,
      model: agent.model ?? agent.runtimeInfo?.model ?? undefined,
      modeId: agent.currentModeId ?? undefined,
      thinkingOptionId: agent.thinkingOptionId ?? undefined,
    }
  }
  const { provider, model, thinking, cwd, agent: plan } = draft()
  return { provider, cwd: cwd ?? process.cwd(), model, modeId: agentConfig(provider, plan ?? "build").modeId, thinkingOptionId: thinking }
}

/** Asks until the daemon's own validator accepts the expression (5 fields, in range); Escape cancels. */
async function askCron(value?: string, problem?: string | null): Promise<string | undefined> {
  const input = await dialogs.prompt({
    title: "Cron schedule",
    description: problem ?? "minute hour day-of-month month day-of-week, e.g. 0 9 * * 1-5 (weekdays at 9:00)",
    placeholder: "0 9 * * *",
    value,
  })
  if (input === undefined) return
  const error = validateCronExpression(input.trim())
  return error ? askCron(input, error) : input.trim()
}

/** Prompt, cron and optional name, then create: a heartbeat on the open session, or a new session per run. */
export async function createSchedule(kind: "heartbeat" | "new") {
  const agent = current()
  if (kind === "heartbeat" && !agent) return notify("Open a session to heartbeat it", "warning")
  const prompt = await dialogs.prompt({
    title: kind === "heartbeat" ? "Heartbeat prompt" : "Schedule prompt",
    description: kind === "heartbeat" ? "Sent to this session on every run" : "Starts a new session with this prompt on every run",
  })
  if (!prompt?.trim()) return
  const cron = await askCron()
  if (!cron) return
  const name = await dialogs.prompt({ title: "Name", description: "Optional", placeholder: "Nightly dependency check" })
  if (name === undefined) return
  const result = await daemon
    .scheduleCreate({
      prompt: prompt.trim(),
      name: name.trim() || undefined,
      cadence: { type: "cron", expression: cron, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      target: kind === "heartbeat" ? { type: "self", agentId: agent!.id } : { type: "new-agent", config: newAgentConfig() },
    })
    .catch(showError)
  if (!result) return
  if (result.error || !result.schedule) return showError(result.error ?? "The daemon didn't create the schedule")
  notify(`${kind === "heartbeat" ? "Heartbeat" : "Schedule"} created: ${scheduleName(result.schedule)}`, "success")
}

export function openSchedules() {
  dialog.replace(() => <Schedules />, "large")
}

const NEW = "\0new"
const HEARTBEAT = "\0heartbeat"

function Schedules() {
  const [list, setList] = createSignal<Schedule[]>()
  const load = () => daemon.scheduleList().then((result) => setList(result.schedules), showError)
  void load()
  // The daemon pushes no schedule changes: poll for runs that fire while the list is open.
  const timer = setInterval(() => void load(), 10_000)
  onCleanup(() => clearInterval(timer))

  const find = (id: string) => list()?.find((schedule) => schedule.id === id)
  /** A flow that opens its own dialogs: come back to the list afterwards, refreshed. */
  const thenList = (flow: Promise<unknown>) => void flow.finally(openSchedules)
  const options = createMemo(() => [
    { title: "New schedule", value: NEW, category: "Create", description: "starts a new session on a cron cadence" },
    ...(current() ? [{ title: "Heartbeat this session", value: HEARTBEAT, category: "Create", description: "sends this session a prompt on a cron cadence" }] : []),
    ...(list() ?? [])
      .toSorted((a, b) => Number(a.target.type === "new-agent") - Number(b.target.type === "new-agent"))
      .map((schedule) => ({
        title: scheduleName(schedule),
        value: schedule.id,
        category: schedule.target.type === "new-agent" ? "Schedules" : "Heartbeats",
        description: cadenceLabel(schedule.cadence),
        footer: schedule.status,
        gutter: () => <text fg={schedule.status === "active" ? theme.success : theme.textMuted}>{schedule.status === "completed" ? "✓" : schedule.status === "active" ? "●" : "○"}</text>,
      })),
  ])

  async function details(schedule: Schedule) {
    const logs = await daemon.scheduleLogs({ id: schedule.id }).catch(showError)
    if (!logs) return
    await dialogs.alert(scheduleName(schedule), scheduleDetails(schedule, logs.runs) + (logs.error ? `\n\n${logs.error}` : ""), "large")
  }
  const change = (work: Promise<{ error: string | null }>, done: string) =>
    work.then((result) => (result.error ? showError(result.error) : notify(done, "success")), showError).finally(() => void load())
  const act = (key: string, title: string, run: (schedule: Schedule) => void) => ({
    title,
    label: key,
    match: (event: KeyEvent) => event.name === key && !event.ctrl && !event.meta,
    run: (option: { value: string }) => {
      const schedule = find(option.value)
      if (schedule) run(schedule)
    },
  })
  return (
    <DialogSelect
      title="Schedules & heartbeats"
      options={options()}
      search={false}
      onSelect={(option) => {
        if (option.value === NEW) return thenList(createSchedule("new"))
        if (option.value === HEARTBEAT) return thenList(createSchedule("heartbeat"))
        const schedule = find(option.value)
        if (schedule) thenList(details(schedule))
      }}
      actions={[
        act("p", "pause/resume", (schedule) =>
          change(schedule.status === "paused" ? daemon.scheduleResume({ id: schedule.id }) : daemon.schedulePause({ id: schedule.id }), schedule.status === "paused" ? "Resumed" : "Paused"),
        ),
        act("r", "run once", (schedule) => change(daemon.scheduleRunOnce({ id: schedule.id }), "Running now")),
        act("d", "delete", (schedule) =>
          thenList(
            dialogs.confirm("Delete schedule", `Delete "${scheduleName(schedule)}"? Its run history goes with it.`, "Delete").then((ok) => {
              if (ok) return change(daemon.scheduleDelete({ id: schedule.id }), "Deleted")
            }),
          ),
        ),
      ]}
    />
  )
}
