import { afterEach, expect, spyOn, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { agents, api, daemon, loadOlder, openSubagentTimeline, openTimeline, sessionTitle, setAgents, setWorkspaceTitles, timeline, type PaseoAgent } from "./paseo"

const agent = (id: string, workspaceId: string, title: string) => ({ id, workspaceId, title }) as PaseoAgent

test("a lone session shows its workspace's generated title, live; shared workspaces keep agent titles", () => {
  setAgents({ a: agent("a", "w", "Lets update our packages to latest bun") })
  setWorkspaceTitles({ w: "Lets update our packages to latest bun" })
  const seen: (string | null | undefined)[] = []
  createRoot(() => createEffect(() => seen.push(sessionTitle(agents.a!))))
  // Paseo's auto-name after the first message only rewrites the workspace title.
  setWorkspaceTitles("w", "Upgrade Bun to 1.4.3")
  expect(seen).toEqual(["Lets update our packages to latest bun", "Upgrade Bun to 1.4.3"])
  setWorkspaceTitles("w", null)
  expect(sessionTitle(agents.a!)).toBe("Lets update our packages to latest bun")
  setWorkspaceTitles("w", "Shared workspace")
  setAgents("b", agent("b", "w", "Child task"))
  expect([sessionTitle(agents.a!), sessionTitle(agents.b!)]).toEqual(["Lets update our packages to latest bun", "Child task"])
})

const realRef = api.agents.ref
afterEach(async () => {
  await openTimeline(undefined)
  api.agents.ref = realRef
})

// A fake daemon timeline: each refetch waits until the test resolves (or rejects) it.
function fakeTimeline() {
  const calls: { args: { cursor?: unknown }; resolve: (page: unknown) => void; reject: (error: Error) => void }[] = []
  let listener: ((message: unknown) => void) | undefined
  api.agents.ref = (() => ({
    timeline: {
      refetch: (args: { cursor?: unknown }) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
      subscribe: (callback: (message: unknown) => void) => {
        listener = callback
        return Object.assign(() => (listener = undefined), { ready: Promise.resolve() })
      },
    },
  })) as unknown as typeof api.agents.ref
  return { calls, send: (message: unknown) => listener?.(message) }
}
const message = (text: string) => ({ type: "assistant_message", text, messageId: text }) as const
const page = (texts: string[], older = false, seq = texts.length) => ({
  entries: texts.map((text) => ({ item: message(text), timestamp: "2026-10-20T10:00:00Z" })),
  hasOlder: older,
  startCursor: older ? { seq: 1 } : null,
  endCursor: { seq },
})
const texts = () => timeline.rows.map((row) => (row as { text: string }).text)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("loadOlder shares one request: holding PageUp prepends the page once", async () => {
  const { calls } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  calls[0]!.resolve(page(["new"], true))
  await opening
  const first = loadOlder()
  const second = loadOlder()
  expect(calls.length).toBe(2)
  calls[1]!.resolve(page(["old"]))
  expect(await Promise.all([first, second])).toEqual([true, true])
  expect(texts()).toEqual(["old", "new"])
})

test("a page requested before the same session reopened is dropped", async () => {
  const { calls } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  calls[0]!.resolve(page(["new"], true))
  await opening
  const stale = loadOlder()
  const reopening = openTimeline("a")
  await tick()
  calls[2]!.resolve(page(["new", "newer"], true))
  await reopening
  calls[1]!.resolve(page(["old"]))
  expect(await stale).toBe(false)
  expect(texts()).toEqual(["new", "newer"])
  expect(timeline.hasOlder).toBe(true)
})

test("a replacement during the initial load: only the newest load applies, no TypeError", async () => {
  const { calls, send } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  send({ event: { type: "replacement" } })
  calls[1]!.resolve(page(["newer"]))
  calls[0]!.resolve(page(["older"]))
  await opening
  await tick()
  expect(texts()).toEqual(["newer"])
})

test("failed refetches flush messages and cool down before retrying on a live message", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  const clock = spyOn(Date, "now").mockReturnValue(1000)
  try {
    const { calls, send } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["hi"]))
    await opening
    send({ event: { type: "subscription_restored" } })
    send({ event: { type: "timeline", item: message("during reconnect") }, seq: 2, timestamp: "2026-10-20T10:01:00Z" })
    calls[1]!.reject(new Error("offline"))
    await tick()
    expect(timeline.loading).toBe(false)
    expect(texts()).toEqual(["hi", "during reconnect"])
    clock.mockReturnValue(3999)
    send({ event: { type: "timeline", item: message("during cooldown") }, seq: 3, timestamp: "2026-10-20T10:01:00Z" })
    expect(calls).toHaveLength(2)
    expect(texts()).toEqual(["hi", "during reconnect", "during cooldown"])
    clock.mockReturnValue(4000)
    send({ event: { type: "timeline", item: message("after reconnect") }, seq: 5, timestamp: "2026-10-20T10:01:00Z" })
    expect(calls).toHaveLength(3)
    send({ event: { type: "timeline", item: message("during retry") }, seq: 6, timestamp: "2026-10-20T10:01:01Z" })
    calls[2]!.reject(new Error("still offline"))
    await tick()
    expect(timeline.loading).toBe(false)
    expect(texts()).toEqual(["hi", "during reconnect", "during cooldown", "after reconnect", "during retry"])
    clock.mockReturnValue(6999)
    send({ event: { type: "timeline", item: message("cooling again") }, seq: 7, timestamp: "2026-10-20T10:01:02Z" })
    expect(calls).toHaveLength(3)
    expect(texts().at(-1)).toBe("cooling again")
    expect(log).toHaveBeenCalledTimes(2)
    clock.mockReturnValue(7000)
    send({ event: { type: "timeline", item: message("live again") }, seq: 8, timestamp: "2026-10-20T10:01:02Z" })
    expect(calls).toHaveLength(4)
    calls[3]!.resolve(page(["recovered history"], false, 7))
    await tick()
    expect(texts()).toEqual(["recovered history", "live again"])
  } finally {
    clock.mockRestore()
    log.mockRestore()
  }
})

test("the newest initial refetch failure clears loading and is logged", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { calls, send } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    send({ event: { type: "replacement" } })
    const error = new Error("offline")
    calls[1]!.reject(error)
    await tick()
    expect(timeline.loading).toBe(false)
    expect(log.mock.calls.some((args) => args.includes(error))).toBe(true)
    calls[0]!.resolve(page(["superseded"]))
    await opening
    expect(texts()).toEqual([])
  } finally {
    log.mockRestore()
  }
})

test("a failed replacement refetch retries on the next message from the new epoch", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  const clock = spyOn(Date, "now").mockReturnValue(1000)
  try {
    const { calls, send } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["before rewind"], false, 100))
    await opening
    send({ event: { type: "replacement" } })
    const error = new Error("offline after rewind")
    calls[1]!.reject(error)
    await tick()
    clock.mockReturnValue(4000)
    send({ event: { type: "timeline", item: message("new epoch") }, seq: 1, timestamp: "2026-10-20T10:01:00Z" })
    expect(calls).toHaveLength(3)
    expect(log.mock.calls.some((args) => args.includes(error))).toBe(true)
    expect(texts()).toEqual(["before rewind"])
    send({ event: { type: "timeline", item: message("buffered") }, seq: 2, timestamp: "2026-10-20T10:01:01Z" })
    expect(calls).toHaveLength(3)
    calls[2]!.resolve(page(["new epoch"], false, 1))
    await tick()
    expect(texts()).toEqual(["new epoch", "buffered"])
    send({ event: { type: "timeline", item: message("live") }, seq: 3, timestamp: "2026-10-20T10:01:02Z" })
    expect(texts()).toEqual(["new epoch", "buffered", "live"])
  } finally {
    clock.mockRestore()
    log.mockRestore()
  }
})

test("an exception while flushing buffered events is logged", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  try {
    const { calls, send } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["hi"]))
    await opening
    send({ event: { type: "subscription_restored" } })
    const error = new Error("bad timeline item")
    const item = { get type() { throw error } }
    send({ event: { type: "timeline", item }, seq: 2, timestamp: "2026-10-20T10:01:00Z" })
    calls[1]!.resolve(page(["hi"]))
    await tick()
    expect(log.mock.calls.some((args) => args.includes(error))).toBe(true)
  } finally {
    log.mockRestore()
  }
})

for (const event of ["subscription_restored", "replacement"]) {
  test(`an older page is dropped when ${event} replaces the rows in the same open`, async () => {
    const { calls, send } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["before"], true, 100))
    await opening
    const stale = loadOlder()
    send({ event: { type: event } })
    // Keep the same cursor values: the replaced rows still invalidate the old page.
    calls[2]!.resolve(page(["after"], true, 100))
    await tick()
    calls[1]!.resolve(page(["stale page"]))
    expect(await stale).toBe(false)
    expect(texts()).toEqual(["after"])
    expect(timeline.hasOlder).toBe(true)
    expect(timeline.startCursor?.seq).toBe(1)
  })
}

for (const reject of [false, true]) {
  test(`loadOlder starts a new request after its shared promise ${reject ? "rejects" : "resolves"}`, async () => {
    const { calls } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["new"], true))
    await opening
    const first = loadOlder()
    expect(loadOlder()).toBe(first)
    if (reject) {
      const error = new Error("offline")
      calls[1]!.reject(error)
      await expect(first).rejects.toThrow(error)
    } else {
      calls[1]!.resolve(page(["old"], true))
      expect(await first).toBe(true)
    }
    const next = loadOlder()
    expect(calls).toHaveLength(3)
    calls[2]!.resolve(page(["oldest"]))
    expect(await next).toBe(true)
    expect(texts()).toEqual(reject ? ["oldest", "new"] : ["oldest", "old", "new"])
  })
}

test("opening a subagent drops an in-flight older page", async () => {
  const fetch = spyOn(daemon, "fetchProviderSubagentTimeline").mockResolvedValue({ rows: [{ item: message("child"), timestamp: "2026-10-20T10:00:00Z" }] } as never)
  try {
    const { calls } = fakeTimeline()
    const opening = openTimeline("a")
    await tick()
    calls[0]!.resolve(page(["parent"], true))
    await opening
    const stale = loadOlder()
    await openSubagentTimeline("a", "child")
    calls[1]!.resolve(page(["old parent"]))
    expect(await stale).toBe(false)
    expect(timeline.agentId).toBe("a:child")
    expect(texts()).toEqual(["child"])
    expect(timeline.hasOlder).toBe(false)
  } finally {
    await openTimeline(undefined)
    fetch.mockRestore()
  }
})
