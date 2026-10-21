import { type Renderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogSelect, type SelectOption } from "../src/dialog"
import { api, openTimeline, setTimeline, timeline } from "../src/paseo"
import { loadPlugins } from "../src/plugin"
import { PromptSpinner } from "../src/prompt/spinner"
import { Spinner, Transcript, type TranscriptProps } from "../src/session"
import { Sidebar, sidebarFeatures } from "../src/sidebar"
import { theme } from "../src/theme"
import type { PaseoAgent } from "../src/paseo"

let screen: TestRendererSetup | undefined
const realRef = api.agents.ref
afterEach(async () => {
  screen?.renderer.destroy()
  screen = undefined
  await openTimeline(undefined)
  api.agents.ref = realRef
})

const all = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...all(child)])
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

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
const at = "2026-10-20T10:00:00Z"
const call = (status: string, detail: unknown, name = "Bash") => ({ type: "tool_call", callId: "c1", name, status, error: null, detail })
const live = (send: (message: unknown) => void, item: unknown, seq: number) => send({ event: { type: "timeline", item }, seq, timestamp: at })

const defaults: TranscriptProps = {
  rows: [], times: [], marks: [], running: false, agent: { label: "Build", color: theme.agent }, model: "Opus 5.5",
  verbosity: "medium", thinking: "hide", grouping: "auto", details: false, timestamps: false, diffStyle: "auto", tps: true, markdown: "rendered", images: true,
}

// The transcript reads the raw rows keyed on the store's revision; a live path that forgets to bump it leaves grouping and footers stale.
test("a tool row replaced in place regroups the transcript and updates its turn footer", async () => {
  const { calls, send } = fakeTimeline()
  const opening = openTimeline("a")
  await tick()
  calls[0]!.resolve({ entries: [{ item: { type: "user_message", text: "Go" }, timestamp: at }, { item: call("running", { type: "unknown", input: null, output: null }), timestamp: at }], hasOlder: false, startCursor: null, endCursor: { seq: 2 } })
  await opening
  screen = await testRender(() => <Transcript {...defaults} rows={timeline.rows} revision={timeline.revision} times={timeline.times} marks={timeline.marks} />, { width: 80, height: 20 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Bash")
  expect(screen.captureCharFrame()).not.toContain("Explored")
  expect(screen.captureCharFrame()).not.toContain("interrupted")

  // Same callId: the row is replaced, the row count doesn't change.
  live(send, call("canceled", { type: "read", filePath: "a.ts" }, "Read"), 3)
  await screen.flush()
  expect(timeline.rows).toHaveLength(2)
  expect(screen.captureCharFrame()).toContain("Explored: 1 read")
  expect(screen.captureCharFrame()).toContain("interrupted")
})

test("the Modified Files rows keep their renderables while an edit changes their counts", async () => {
  const agent = { id: "a", title: "Fixture", status: "idle", cwd: "/p", provider: "claude", pendingPermissions: [] } as unknown as PaseoAgent
  const edit = (callId: string, file: string, newString: string) => ({ type: "tool_call", callId, name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: `/p/${file}`, oldString: "x\n", newString } }) as never
  setTimeline({ agentId: "a", rows: [edit("1", "a.ts", "x\ny\n"), edit("2", "b.ts", "x\ny\n")], times: [1, 2], marks: [] })
  screen = await testRender(() => {
    void loadPlugins(useRenderer(), sidebarFeatures)
    return <Sidebar agent={agent} />
  }, { width: 40, height: 30 })
  await screen.renderOnce()
  const row = (file: string) => all(screen!.renderer.root).find((node) => (node as { plainText?: string }).plainText === file)
  const [a, b] = [row("a.ts"), row("b.ts")]
  expect(a && b).toBeTruthy()

  setTimeline("rows", (rows) => [...rows, edit("3", "a.ts", "x\ny\nz\n")])
  setTimeline("revision", (revision) => revision + 1)
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("+5 -2")
  expect(row("a.ts")).toBe(a!)
  expect(row("b.ts")).toBe(b!)
  setTimeline({ agentId: undefined, rows: [], times: [], marks: [] })
})

test("dialog rows are keyed by option.value: a rebuilt list keeps each row's renderable, even reordered", async () => {
  const option = (value: string, footer = ""): SelectOption<string> => ({ title: `Session ${value}`, value, footer })
  const [options, setOptions] = createSignal([option("a"), option("b"), option("c")])
  screen = await testRender(() => <DialogSelect title="Sessions" options={options()} onSelect={() => {}} />, { width: 70, height: 24 })
  await screen.renderOnce()
  const row = (index: number) => screen!.renderer.root.findDescendantById(`dialog-option-${index}`)
  const [a, b, c] = [row(0), row(1), row(2)]
  expect(a && b && c).toBeTruthy()

  setOptions([option("a"), option("b", "updated"), option("c")])
  await screen.renderOnce()
  expect([row(0), row(1), row(2)]).toEqual([a, b, c])
  expect(screen.captureCharFrame()).toContain("updated")

  setOptions([option("c"), option("a"), option("b", "updated")])
  await screen.renderOnce()
  expect([row(0), row(1), row(2)]).toEqual([c, a, b])
})

test("one spinner clock runs while a spinner is mounted with animations on, and stops after", async () => {
  const set = spyOn(globalThis, "setInterval")
  const clear = spyOn(globalThis, "clearInterval")
  try {
    const [show, setShow] = createSignal(true)
    screen = await testRender(() => <box>{show() && <><Spinner>One</Spinner><Spinner>Two</Spinner><PromptSpinner color={theme.agent} /></>}</box>, { width: 40, height: 6 })
    await screen.renderOnce()
    const clocks = () => set.mock.calls.filter(([, ms]) => ms === 80).length
    expect(clocks()).toBe(1)
    const stopped = clear.mock.calls.length
    setShow(false)
    await screen.renderOnce()
    expect(clear.mock.calls.length).toBe(stopped + 1)
  } finally {
    set.mockRestore()
    clear.mockRestore()
  }
})
