import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types"
import { CodeRenderable, DiffRenderable, ImageRenderable, MarkdownRenderable, type Renderable } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Transcript, type TranscriptProps, type TranscriptRef } from "../session"
import { theme } from "../theme"
import { timestampLabel } from "./helpers"

let screen: TestRendererSetup | undefined
afterEach(() => { screen?.renderer.destroy(); screen = undefined })

const defaults: TranscriptProps = {
  rows: [], times: [], marks: [], running: false, agent: { label: "Build", color: theme.agent }, model: "Opus 5.5",
  verbosity: "medium", thinking: "hide", grouping: "auto", details: false, timestamps: false, diffStyle: "auto", tps: true, markdown: "rendered", images: true,
}
function tool(detail: ToolCallDetail): AgentTimelineItem {
  return { type: "tool_call", name: detail.type, callId: detail.type, status: "completed", error: null, detail }
}
function descendants(node: Renderable): Renderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)])
}
async function flush() {
  await screen!.flush()
  await Promise.all(descendants(screen!.renderer.root).filter((node): node is CodeRenderable => node instanceof CodeRenderable).map((node) => node.highlightingDone))
  await Promise.all(descendants(screen!.renderer.root).filter((node): node is ImageRenderable => node instanceof ImageRenderable).map((node) => node.loadPromise))
  await screen!.flush()
}

test("low activity text expands/collapses and preserves row ids for each top-level unit", async () => {
  const rows: AgentTimelineItem[] = [
    { type: "user_message", text: "Inspect" }, { type: "reasoning", text: "**Inspecting code**\n\nDetails" },
    tool({ type: "shell", command: "pwd", output: "/work" }), tool({ type: "read", filePath: "a.ts", offset: 1 }),
    { type: "assistant_message", text: "Finished" }, { type: "user_message", text: "Next" },
  ]
  screen = await testRender(() => <Transcript {...defaults} rows={rows} times={[1000, 1100, 1200, 1300, 2000, 3000]} verbosity="low" />, { width: 90, height: 35 })
  await flush()
  expect(screen.captureCharFrame()).toContain("+ 1 command, 1 thought, 1 read")
  expect(screen.captureCharFrame()).not.toContain("$ pwd")
  expect(screen.renderer.root.getChildren().map((node) => node.id)).toEqual(["row-0", "row-1", "row-4", "row-5"])
  const group = screen.renderer.root.getChildren()[1]!
  await screen.mockMouse.click(group.x + 1, group.y)
  await flush()
  expect(screen.captureCharFrame()).toContain("− 1 command, 1 thought, 1 read")
  expect(screen.captureCharFrame()).toContain("$ pwd")
  await screen.mockMouse.click(group.x + 1, group.y)
  await flush()
  expect(screen.captureCharFrame()).toContain("+ 1 command, 1 thought, 1 read")
  expect(screen.captureCharFrame()).not.toContain("$ pwd")
})

test("low reasoning-only run says + 1 thought", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "reasoning", text: "Think" }]} times={[1000]} verbosity="low" />, { width: 80, height: 10 })
  await flush()
  expect(screen.captureCharFrame()).toContain("+ 1 thought")
})

test("footer uses completed turn timing, tps toggle, colors and narrow width rules", async () => {
  const [tps, setTps] = createSignal(true)
  const [running, setRunning] = createSignal(false)
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Hi" }, { type: "assistant_message", text: "Answer" }]} times={[1000, 1100]} marks={[{ kind: "turn_completed", at: 3100, outputTokens: 10.8 }]} tps={tps()} running={running()} />, { width: 80, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 · 2.1s · 5.1 tok/s")
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "Build")?.fg).toEqual(theme.agent)
  setTps(false)
  await flush()
  expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 · 2.1s")
  expect(screen.captureCharFrame()).not.toContain("tok/s")
  screen.resize(30, 15)
  await flush()
  expect(screen.captureCharFrame()).toContain("Build · Opus 5.5")
  expect(screen.captureCharFrame()).not.toContain("2.1s")
  screen.resize(26, 15)
  await flush()
  expect(screen.captureCharFrame()).toContain("Build · 2.1s")
  expect(screen.captureCharFrame()).not.toContain("Opus")
  setRunning(true)
  await flush()
  expect(screen.captureCharFrame()).not.toContain("Build")
})

test("historical footer has no tps, only final turn step gets a footer", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Hi" }, { type: "assistant_message", text: "One" }, tool({ type: "shell", command: "pwd" }), { type: "assistant_message", text: "Two" }]} times={[1000, 1100, 2000, 3100]} />, { width: 80, height: 20 })
  await flush()
  expect(screen.captureCharFrame().match(/Build/g)).toHaveLength(1)
  expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 · 2.1s")
  expect(screen.captureCharFrame()).not.toContain("tok/s")
})

test("user bubbles use agent color, image attachment chips, and collapsed fork context", async () => {
  const row = { type: "user_message" as const, text: '<chat-history-summary>\nSource agent: original\nlong history\n</chat-history-summary>\nLook at these images' }
  screen = await testRender(() => <Transcript {...defaults} rows={[row]} times={[1000]} attachments={(message, index) => {
    expect(message).toBe(row)
    expect(index).toBe(0)
    return [{ mimeType: "image/png" }, { mimeType: "image/png", name: "screenshot.png" }]
  }} />, { width: 90, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain("↳ forked from original")
  expect(screen.captureCharFrame()).not.toContain("long history")
  expect(screen.captureCharFrame()).toContain("file  clipboard")
  expect(screen.captureCharFrame()).toContain("file  screenshot.png")
  expect(descendants(screen.renderer.root).some((node) => node instanceof ImageRenderable)).toBe(false)
  const spans = screen.captureSpans().lines.flatMap((line) => line.spans)
  expect(spans.find((span) => span.text === " file ")?.bg).toEqual(theme.accent)
})

test("image labels are ordinary text and missing attachment props render no chips or thumbnails", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Look [Image 1] [Image 2]" }]} times={[1000]} />, { width: 90, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain("Look [Image 1] [Image 2]")
  expect(screen.captureCharFrame()).not.toContain("file  clipboard")
  expect(descendants(screen.renderer.root).some((node) => node instanceof ImageRenderable)).toBe(false)
})

// PNG fixture from OpenCode 2.0.26 test/fixture/diff-image.ts (MIT); see OPENCODE-LICENSE.
const png = "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAIAAABhdOiYAAABX0lEQVR42u3XwQkCMRCF4eljwVoET3r1YAGCbCcebMMCrMEW7MWrLiysi+4ms5PJJDEP/lsu4WMGEtpf78gRgQBAAAIQgCSttse5o9ej/a0uoE6nj6kjNqKidX6NHDoyIypdZ2zk1REY6QPtDhdjncGoAKBOp89Ypy9roIFmnKUO3ygB0KSOohFTh2lkCuSg0WJapMMxsgNi6oQYCXS8RkZAi3RkRmIdh5HFO0hAI2AK1Jk0snhJB+owjVR0voyi/8VUaLxMijRz35EoQOo6k0aRdEKMKKHOl1FUHbERJaQZZ6AjM6KqdARGlJbGXmepEVWos8iI6tThG1ESmhx0mEZUsw7HiCrX8RoRdPrmLkxNe0aOAAQgAE32vJ3GAQgTBKBIyxW4aNSsN58wMh4gSHGBipVy7Jdsy3xA1Y8VgBSB8hb0Lpds0VSB/nESUwAVhZgrUDaOhQPFR6wAKMzxDTghptXEGbWAAAAAAElFTkSuQmCC"

test("native attachments render three byte-backed thumbnails above text, +N more, and every chip", async () => {
  const attachments = [{ mimeType: "image/png", name: "remembered.png" }, ...Array.from({ length: 5 }, (_, index) => ({ mimeType: "image/png", data: png, name: `image-${index + 1}.png` }))]
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Look at the previews" }]} times={[1000]} attachments={() => attachments} />, { width: 110, height: 32 })
  await flush()
  const images = descendants(screen.renderer.root).filter((node): node is ImageRenderable => node instanceof ImageRenderable)
  expect(images).toHaveLength(3)
  for (const image of images) {
    expect(image.source).toEqual(Uint8Array.from(Buffer.from(png, "base64")))
    expect(image.fit).toBe("cover")
    expect(image.protocol).toBe("auto")
    expect(image.parent?.width).toBe(16)
    expect(image.parent?.height).toBe(8)
  }
  const frame = screen.captureCharFrame()
  expect(frame).toContain("+2 more")
  expect(frame.match(/ file /g)).toHaveLength(6)
  expect(frame.indexOf("+2 more")).toBeLessThan(frame.indexOf("Look at the previews"))
  screen.resize(110, 24)
  await flush()
  expect(images[0]?.parent?.height).toBe(6)
  expect(images[0]?.parent?.width).toBe(12)
  screen.resize(110, 12)
  await flush()
  expect(images[0]?.parent?.height).toBe(4)
  expect(images[0]?.parent?.width).toBe(8)
  screen.resize(110, 80)
  await flush()
  expect(images[0]?.parent?.height).toBe(8)
})

test("broken byte-backed images fall back to No preview without losing their chips", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Broken image" }]} times={[1000]} attachments={() => [{ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") }]} />, { width: 80, height: 20 })
  await flush()
  expect(screen.captureCharFrame()).toContain("No preview")
  expect(screen.captureCharFrame()).toContain("file  clipboard")
  expect(descendants(screen.renderer.root).some((node) => node instanceof ImageRenderable)).toBe(false)
})

test("thinking hide collapses reasoning, show renders full muted reasoning; redacted-only renders nothing", async () => {
  const [thinking, setThinking] = createSignal<"show" | "hide">("hide")
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "reasoning", text: "**Inspecting code**\n\nDetailed reasoning" }]} times={[1000]} thinking={thinking()} />, { width: 80, height: 20 })
  await flush()
  expect(screen.captureCharFrame()).toContain("+ Thought: Inspecting code")
  expect(screen.captureCharFrame()).not.toContain("Detailed reasoning")
  await screen.mockMouse.click(3, 1)
  await flush()
  expect(screen.captureCharFrame()).toContain("- Thought")
  expect(screen.captureCharFrame()).toContain("Detailed reasoning")
  setThinking("show")
  await flush()
  expect(screen.captureCharFrame()).toContain("Thought")
  expect(screen.captureCharFrame()).toContain("Detailed reasoning")
  expect(screen.captureCharFrame()).not.toContain("+ Thought")
})

test("medium collapses exploration, high opens it, grouping none renders tools individually", async () => {
  const [verbosity, setVerbosity] = createSignal<"medium" | "high">("medium")
  const [grouping, setGrouping] = createSignal<"auto" | "none">("auto")
  screen = await testRender(() => <Transcript {...defaults} rows={[tool({ type: "read", filePath: "a.ts", offset: 1 }), tool({ type: "search", query: "needle", toolName: "grep", numMatches: 2 })]} times={[1000, 1100]} verbosity={verbosity()} grouping={grouping()} />, { width: 90, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain("Explored: 1 read, 1 search")
  expect(screen.captureCharFrame()).not.toContain("Read a.ts")
  setVerbosity("high")
  await flush()
  expect(screen.captureCharFrame()).toContain("Read a.ts")
  expect(screen.captureCharFrame()).toContain('Grep "needle" (2 matches)')
  expect(screen.captureCharFrame()).not.toContain("offset=1")
  setGrouping("none")
  await flush()
  expect(screen.captureCharFrame()).toContain("Read a.ts")
  expect(screen.captureCharFrame()).not.toContain("Explored:")
})

test("streamed markdown retains its renderer across delta updates", async () => {
  const [rows, setRows] = createSignal<AgentTimelineItem[]>([{ type: "assistant_message", text: "First" }])
  screen = await testRender(() => <Transcript {...defaults} rows={rows()} times={[1000]} running />, { width: 80, height: 15 })
  await flush()
  const markdown = descendants(screen.renderer.root).find((node) => node instanceof MarkdownRenderable)
  setRows([{ type: "assistant_message", text: "First, continued" }])
  await flush()
  expect(screen.captureCharFrame()).toContain("First, continued")
  expect(descendants(screen.renderer.root).find((node) => node instanceof MarkdownRenderable)).toBe(markdown)
})

test("expanded activity survives new rows and streamed deltas", async () => {
  const [rows, setRows] = createSignal<AgentTimelineItem[]>([tool({ type: "shell", command: "pwd" })])
  screen = await testRender(() => <Transcript {...defaults} rows={rows()} times={[1000, 1100]} verbosity="low" running />, { width: 80, height: 20 })
  await flush()
  await screen.mockMouse.click(1, 1)
  await flush()
  expect(screen.captureCharFrame()).toContain("$ pwd")
  setRows([tool({ type: "shell", command: "pwd", output: "/work" }), tool({ type: "shell", command: "ls", output: "a.ts" })])
  await flush()
  expect(screen.captureCharFrame()).toContain("− 2 commands")
  expect(screen.captureCharFrame()).toContain("$ ls")
})

test("transcript shell previews the tail without a redundant header or expand label", async () => {
  const [details, setDetails] = createSignal(false)
  screen = await testRender(() => <Transcript {...defaults} rows={[tool({ type: "shell", command: "printf lines", output: Array.from({ length: 15 }, (_, i) => `output ${i + 1}`).join("\n") })]} times={[1000]} details={details()} />, { width: 80, height: 25 })
  await flush()
  expect(screen.captureCharFrame()).toContain("$ printf lines")
  expect(screen.captureCharFrame()).toContain("(8 earlier lines)")
  expect(screen.captureCharFrame()).toContain("output 15")
  expect(screen.captureCharFrame()).not.toContain("output 1 ")
  expect(screen.captureCharFrame()).not.toContain("Shell")
  expect(screen.captureCharFrame()).not.toContain("Click to expand")
  setDetails(true)
  await flush()
  expect(screen.captureCharFrame()).toContain("output 1 ")
})

test("transcript writes use # Wrote and edits render real diff blocks", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[tool({ type: "write", filePath: "new.ts", content: "const answer = 42" }), tool({ type: "edit", filePath: "old.txt", oldString: "before\n", newString: "after\n" })]} times={[1000, 1100]} />, { width: 80, height: 25 })
  await flush()
  expect(screen.captureCharFrame()).toContain("# Wrote new.ts")
  expect(screen.captureCharFrame()).toContain("const answer = 42")
  expect(screen.captureCharFrame()).toContain("← Edit old.txt")
  expect(screen.captureCharFrame()).toContain("before")
  expect(screen.captureCharFrame()).toContain("after")
})

test("auto diffs follow actual transcript width, not terminal width with a narrow pane", async () => {
  screen = await testRender(() => <box width={80}><Transcript {...defaults} rows={[tool({ type: "edit", filePath: "a.txt", oldString: "old\n", newString: "new\n" })]} times={[1000]} /></box>, { width: 160, height: 15 })
  await flush()
  const diff = descendants(screen.renderer.root).find((node) => node instanceof DiffRenderable) as DiffRenderable
  expect(diff.view).toBe("unified")
})

test("read ranges match OpenCode's path:start-end notation", async () => {
  screen = await testRender(() => <Transcript {...defaults} grouping="none" rows={[tool({ type: "read", filePath: "a.ts", offset: 1, limit: 20 }), tool({ type: "read", filePath: "b.ts", offset: 3 })]} times={[1000, 1100]} />, { width: 80, height: 10 })
  await flush()
  expect(screen.captureCharFrame()).toContain("Read a.ts:1-20")
  expect(screen.captureCharFrame()).toContain("Read b.ts:3-")
  expect(screen.captureCharFrame()).not.toContain("offset=")
})

test("timestamps are opt-in and redacted-only thoughts produce no labels", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Hello" }, { type: "reasoning", text: "[REDACTED]" }]} times={[1000, 1100]} timestamps running />, { width: 80, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain(timestampLabel(1000))
  expect(screen.captureCharFrame()).not.toContain("Thought")
  expect(screen.captureCharFrame()).not.toContain("Thinking")
  expect(screen.captureCharFrame()).not.toContain("REDACTED")
})

test("terminal errors render once and error footer agent color is muted", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Hi" }, { type: "error", message: "Network failure" }]} times={[1000, 2000]} />, { width: 80, height: 15 })
  await flush()
  expect(screen.captureCharFrame().match(/Error: Network failure/g)).toHaveLength(1)
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Build"))?.fg).toEqual(theme.textMuted)
})

test("interrupted footer is muted and terminal errors are displayed once", async () => {
  screen = await testRender(() => <Transcript {...defaults} rows={[{ type: "user_message", text: "Hi" }, { type: "error", message: "Step interrupted" }]} times={[1000, 2000]} />, { width: 80, height: 15 })
  await flush()
  expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 · 1.0s · interrupted")
  expect(screen.captureCharFrame()).not.toContain("Error:")
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Build"))?.fg).toEqual(theme.textMuted)
})

const ids = () => screen!.renderer.root.getChildren().map((node) => node.id)
const users = (from: number, count: number) => Array.from({ length: count }, (_, i): AgentTimelineItem => ({ type: "user_message", text: `m${from + i}` }))

test("tail-first: only the newest 40 nodes mount; reveal mounts older chunks or back to a row", async () => {
  const rows = users(0, 120)
  let ref: TranscriptRef | undefined
  screen = await testRender(() => <Transcript {...defaults} rows={rows} times={rows.map(() => 1000)} ref={(r) => (ref = r)} />, { width: 80, height: 20 })
  await flush()
  expect(ids()).toEqual(Array.from({ length: 40 }, (_, i) => `row-${80 + i}`))
  expect(ref!.hidden()).toBe(true)
  expect(ref!.reveal()).toBe(true)
  await flush()
  expect(ids()[0]).toBe("row-20")
  expect(ref!.reveal(30)).toBe(false)
  expect(ref!.reveal(5)).toBe(true)
  await flush()
  expect(ids()[0]).toBe("row-5")
  expect(ids()).toHaveLength(115)
  expect(ref!.reveal()).toBe(true)
  await flush()
  expect(ids()[0]).toBe("row-0")
  expect(ref!.hidden()).toBe(false)
  expect(ref!.reveal()).toBe(false)
})

test("pinned rows stay mounted across appends and prepended history; unpinned follow the tail", async () => {
  const [state, setState] = createStore({ rows: users(0, 50) })
  let ref: TranscriptRef | undefined
  screen = await testRender(() => <Transcript {...defaults} rows={state.rows} times={state.rows.map(() => 1000)} ref={(r) => (ref = r)} />, { width: 80, height: 20 })
  await flush()
  expect(ids()[0]).toBe("row-10")
  ref!.pin(true)
  setState(produce((draft) => void draft.rows.push(...users(50, 2))))
  await flush()
  expect(ids()[0]).toBe("row-10")
  // loadOlder's unshift: the same row (now index 15) stays first.
  setState(produce((draft) => void draft.rows.unshift(...users(-5, 5))))
  await flush()
  expect(ids()[0]).toBe("row-15")
  expect(state.rows[15]!.type === "user_message" && state.rows[15]!.text).toBe("m10")
  ref!.pin(false)
  await flush()
  expect(ids()[0]).toBe("row-17")
  // A session switch empties the timeline; the next one starts at its tail.
  ref!.reveal(0)
  ref!.pin(true)
  setState("rows", [])
  setState("rows", users(0, 50))
  await flush()
  expect(ids()[0]).toBe("row-10")
})

test("tail budget counts rows a group shows inline, one for a collapsed group", async () => {
  const reads = (count: number) => Array.from({ length: count }, (_, i) => tool({ type: "read", filePath: `${i}.ts` }))
  const rows = [0, 1, 2].flatMap((turn) => [...users(turn, 1), ...reads(30)])
  const [grouping, setGrouping] = createSignal<"auto" | "none">("none")
  screen = await testRender(() => <Transcript {...defaults} rows={rows} times={rows.map(() => 1000)} grouping={grouping()} />, { width: 80, height: 20 })
  await flush()
  expect(ids()[0]).toBe("row-32")
  setGrouping("auto")
  await flush()
  expect(ids()[0]).toBe("row-0")
})

test("a page prepended while pinned doesn't mount above the pinned rows, not even for one pass", async () => {
  const [state, setState] = createStore({ rows: users(0, 50) })
  let ref: TranscriptRef | undefined
  screen = await testRender(() => <Transcript {...defaults} rows={state.rows} times={state.rows.map(() => 1000)} ref={(r) => (ref = r)} />, { width: 80, height: 20 })
  await flush()
  ref!.pin(true)
  const add = spyOn(screen.renderer.root, "add")
  const insert = spyOn(screen.renderer.root, "insertBefore")
  setState(produce((draft) => void draft.rows.unshift(...users(-300, 300))))
  // Only the 40 pinned rows remount under their shifted index keys.
  expect(add.mock.calls.length + insert.mock.calls.length).toBe(40)
  expect(ids()[0]).toBe("row-310")
})

test("an agent's message is a message from its sender, not a tool call, even at low verbosity", async () => {
  const message = (sender: { id: string; title?: string }, event: "message" | "finished", text: string): AgentTimelineItem =>
    ({ type: "tool_call", callId: sender.id, name: "agent_message", status: "completed", error: null, detail: { type: "unknown", input: null, output: null }, agentMessage: { event, sender, text } })
  const rows: AgentTimelineItem[] = [
    { type: "user_message", text: "Ask the reviewer" },
    message({ id: "3f2a9c1e-0b7d-4e55-9a31-5d0c7e8b1a42", title: "Reviewer" }, "message", "Looks good to me"),
    message({ id: "9b1d7c20-1111-4222-8333-444455556666" }, "finished", "Done."),
  ]
  screen = await testRender(() => <Transcript {...defaults} rows={rows} times={[1000, 1100, 1200]} verbosity="low" />, { width: 80, height: 20 })
  await flush()
  const frame = screen.captureCharFrame()
  expect(frame).toContain("from Reviewer")
  expect(frame).toContain("Looks good to me")
  expect(frame).toContain("from 9b1d7c20 · finished")
  expect(frame).toContain("Done.")
  expect(frame).not.toMatch(/\d tools?/)
  expect(screen.renderer.root.getChildren().map((node) => node.id)).toEqual(["row-0", "row-1", "row-2"])
})
