import { afterEach, expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { unwrap } from "solid-js/store"
import { agents, api, openTimeline, setAgents, timeline, waiting, type PaseoAgent } from "./paseo"

const realRef = api.agents.ref
afterEach(async () => {
  await openTimeline(undefined)
  api.agents.ref = realRef
})

function fakeTimeline() {
  const calls: { resolve: (page: unknown) => void }[] = []
  let listener: ((message: unknown) => void) | undefined
  api.agents.ref = (() => ({
    timeline: {
      refetch: () => new Promise((resolve) => calls.push({ resolve })),
      subscribe: (callback: (message: unknown) => void) => {
        listener = callback
        return Object.assign(() => (listener = undefined), { ready: Promise.resolve() })
      },
    },
  })) as unknown as typeof api.agents.ref
  return { calls, send: (message: unknown) => listener?.(message) }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const at = "2026-10-20T10:00:00Z"
const tool = (status: string, name = "Read") => ({ type: "tool_call", callId: "c1", name, status, error: null, detail: { type: "unknown", input: null, output: null } })
const entry = (item: unknown) => ({ item, timestamp: at })
const page = (items: unknown[], seq = items.length) => ({ entries: items.map(entry), hasOlder: false, startCursor: null, endCursor: { seq } })

test("revision bumps on a new row and on a row replaced in place, not on a delta merged into the last message", async () => {
  const { calls, send } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  calls[0]!.resolve(page([{ type: "user_message", text: "Go" }]))
  await opening
  const live = (item: unknown, seq: number) => send({ event: { type: "timeline", item }, seq, timestamp: at })
  const revisions: number[] = []
  const bump = () => revisions.push(timeline.revision)

  bump()
  live({ type: "assistant_message", text: "Hel", messageId: "m" }, 2) // a new row
  bump()
  live({ type: "assistant_message", text: "lo", messageId: "m" }, 3) // a delta merged into it
  bump()
  live(tool("running"), 4) // a new row
  bump()
  live(tool("completed"), 5) // the same row, replaced in place
  bump()
  const [start, row, delta, running, completed] = revisions as [number, number, number, number, number]
  expect([row > start, delta === row, running > delta, completed > running]).toEqual([true, true, true, true])
  expect(timeline.rows.map((item) => item.type)).toEqual(["user_message", "assistant_message", "tool_call"])
})

test("a refetch keeps the rows it didn't change (same store nodes), updates the ones it did, and bumps revision", async () => {
  const { calls, send } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  calls[0]!.resolve(page([{ type: "user_message", text: "Go" }, tool("running")]))
  await opening
  const [user, call] = unwrap(timeline.rows)
  const before = timeline.revision
  const rows = timeline.rows

  send({ event: { type: "replacement" } })
  calls[1]!.resolve(page([{ type: "user_message", text: "Go" }, tool("completed"), { type: "assistant_message", text: "Done" }]))
  await tick()

  expect(timeline.rows).toBe(rows)
  expect(unwrap(timeline.rows)[0]).toBe(user)
  expect(unwrap(timeline.rows)[1]).toBe(call)
  expect(timeline.rows.map((row) => row.type === "tool_call" ? row.status : row.type)).toEqual(["user_message", "completed", "assistant_message"])
  expect(timeline.times).toHaveLength(3)
  expect(timeline.marks).toHaveLength(3)
  expect(timeline.revision).toBeGreaterThan(before)
})

test("a session's waiting flag recomputes for the agents it concerns, not for every agent on every update", () => {
  const make = (id: string, status: PaseoAgent["status"], parent?: string) =>
    ({ id, workspaceId: id, title: id, status, labels: parent ? { "paseo.parent-agent-id": parent } : {} }) as PaseoAgent
  const all = Array.from({ length: 50 }, (_, i) => make(`s${i}`, "idle"))
  setAgents(Object.fromEntries(all.map((agent) => [agent.id, agent])))
  setAgents("child", make("child", "idle", "s0"))
  const runs: Record<string, number> = {}
  const seen: Record<string, boolean> = {}
  const dispose = createRoot((dispose) => {
    for (const id of Object.keys(agents)) createEffect(() => ((runs[id] = (runs[id] ?? 0) + 1), (seen[id] = waiting(agents[id]!))))
    return dispose
  })
  try {
    for (const id of Object.keys(runs)) runs[id] = 0
    // An unrelated session starts running: its own flag changes, nobody else's does.
    setAgents("s7", "status", "running")
    expect(Object.entries(runs).filter(([, count]) => count > 0).map(([id]) => id)).toEqual(["s7"])
    // A subagent starts running: it and the session above it recompute, and that session is now waiting.
    for (const id of Object.keys(runs)) runs[id] = 0
    setAgents("child", "status", "running")
    expect(seen.s0).toBe(true)
    expect(Object.entries(runs).filter(([, count]) => count > 0).map(([id]) => id)).toEqual(["s0", "child"])
  } finally {
    dispose()
    setAgents({})
  }
})
