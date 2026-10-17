import type { AgentPermissionRequest, AgentPermissionResponse, ToolCallDetail, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types"
import { BoxRenderable, CodeRenderable, DiffRenderable, MarkdownRenderable, TextAttributes } from "@opentui/core"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { PromptSpinner } from "../prompt/spinner"
import { PermissionPrompt, Spinner, TimelineRow } from "../session"
import { setPref } from "../state"
import { syntax, theme } from "../theme"
import { timestampLabel } from "./helpers"

let screen: TestRendererSetup | undefined
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
})

function tool(detail: ToolCallDetail) {
  return { type: "tool_call" as const, callId: "call", name: detail.type, status: "completed" as const, error: null, detail }
}

test("edit renders a real colored unified diff, with a split override", async () => {
  const [style, setStyle] = createSignal<"unified" | "split" | "auto">("unified")
  screen = await testRender(() => <TimelineRow item={tool({ type: "edit", filePath: "file.txt", oldString: "before\n", newString: "after\n" })} streaming={false} showDetails={false} diffStyle={style()} />, { width: 140, height: 20 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Edit file.txt")
  expect(screen.captureCharFrame()).toContain("before")
  expect(screen.captureCharFrame()).toContain("after")
  const diff = screen.renderer.root.getChildren()[0]?.getChildren().flatMap((child) => [child, ...child.getChildren()]).find((child) => child instanceof DiffRenderable)
  expect(diff).toBeInstanceOf(DiffRenderable)
  expect((diff as DiffRenderable).view).toBe("unified")
  expect((diff as DiffRenderable).addedBg).toEqual(theme.diffAddedBg)
  setStyle("split")
  await screen.flush()
  expect((diff as DiffRenderable).view).toBe("split")
  setStyle("auto")
  await screen.flush()
  expect((diff as DiffRenderable).view).toBe("split")
  screen.resize(80, 20)
  await screen.flush()
  expect((diff as DiffRenderable).view).toBe("unified")
})

test("shell output starts collapsed, expands on click, and follows details", async () => {
  const [details, setDetails] = createSignal(false)
  screen = await testRender(() => <TimelineRow item={tool({ type: "shell", command: "printf lines", output: Array.from({ length: 15 }, (_, i) => `output ${i + 1}`).join("\n") })} streaming={false} showDetails={details()} />, { width: 80, height: 30 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("$ printf lines")
  expect(screen.captureCharFrame()).toContain("output 10")
  expect(screen.captureCharFrame()).not.toContain("output 11")
  expect(screen.captureCharFrame()).toContain("Click to expand")
  setDetails(true)
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("output 15")
  expect(screen.captureCharFrame()).toContain("Click to collapse")
  // Click panel padding so rapid test clicks do not select title text.
  await screen.mockMouse.click(1, 2)
  await screen.flush()
  expect(screen.captureCharFrame()).not.toContain("output 11")
  setDetails(false)
  await screen.flush()
  setDetails(true)
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("output 15")
  await screen.mockMouse.click(1, 2)
  await screen.flush()
  expect(screen.captureCharFrame()).not.toContain("output 11")
  await screen.mockMouse.click(1, 2)
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("output 15")
})

test("collapsed reasoning opens on click; legacy false hides it", async () => {
  const [visible, setVisible] = createSignal(true)
  screen = await testRender(() => <TimelineRow item={{ type: "reasoning", text: "**Inspecting code**\n\nDetailed reasoning" }} streaming={false} showThinking={visible()} showDetails={false} thinking="collapsed" thinkingDurationMs={1500} />, { width: 80, height: 20 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("+ Thought: Inspecting code · 1.5s")
  expect(screen.captureCharFrame()).not.toContain("Detailed reasoning")
  await screen.mockMouse.click(5, 1)
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("- Thought:")
  expect(screen.captureCharFrame()).toContain("Detailed reasoning")
  setVisible(false)
  await screen.flush()
  expect(screen.captureCharFrame().trim()).toBe("")
})

function request(questions: unknown[]): AgentPermissionRequest {
  return { id: "question", provider: "claude", name: "AskUserQuestion", kind: "question", input: { questions } }
}

test("question Other accepts typing and cursor movement, then submits with option answers", async () => {
  const responses: AgentPermissionResponse[] = []
  screen = await testRender(() => <PermissionPrompt request={request([
    { question: "First?", options: ["Yes", "No"] },
    { question: "Second?", options: ["Listed"], allowOther: true },
  ])} onRespond={(response) => responses.push(response)} />, { width: 80, height: 20 })
  await screen.flush()
  screen.mockInput.pressEnter()
  await screen.flush()
  expect(responses).toHaveLength(0)
  expect(screen.captureCharFrame()).toContain("Second?")
  expect(screen.captureCharFrame()).toContain("Other…")
  screen.mockInput.pressArrow("right")
  screen.mockInput.pressEnter()
  await screen.flush()
  await screen.mockInput.typeText("Custom!")
  screen.mockInput.pressArrow("left")
  screen.mockInput.pressBackspace()
  await screen.mockInput.typeText(" answer")
  screen.mockInput.pressEnter()
  await screen.flush()
  expect(responses).toEqual([{ behavior: "allow", updatedInput: { answers: { "First?": "Yes", "Second?": "Custo answer!" } } }])
})

test("escape in Other returns to choices, not rejection; blank answers are not submitted", async () => {
  const responses: AgentPermissionResponse[] = []
  screen = await testRender(() => <PermissionPrompt request={request([{ question: "Which?", options: [], allowOther: true }])} onRespond={(response) => responses.push(response)} />, { width: 80, height: 20 })
  await screen.flush()
  screen.mockInput.pressEnter()
  await screen.flush()
  screen.mockInput.pressEnter()
  await screen.flush()
  expect(responses).toHaveLength(0)
  // Legacy ESC is disambiguated from Alt/CSI sequences after OpenTUI's 20ms timeout.
  await screen.mockInput.pressKeys(["ESCAPE"], 25)
  await screen.flush()
  expect(responses).toHaveLength(0)
  expect(screen.captureCharFrame()).toContain("Other…")
  await screen.mockInput.pressKeys(["ESCAPE"], 25)
  await screen.flush()
  expect(responses).toEqual([{ behavior: "deny", message: "Rejected by user" }])
})

test.each<{ detail: ToolCallDetail; text: string }>([
  { detail: { type: "read", filePath: "src/index.ts", offset: 0, limit: 20 }, text: "Read src/index.ts offset=0 limit=20" },
  { detail: { type: "search", toolName: "grep", query: "needle", numMatches: 0 }, text: 'Grep "needle" (0 matches)' },
  { detail: { type: "search", toolName: "glob", query: "*.ts", numFiles: 1 }, text: 'Glob "*.ts" (1 match)' },
  { detail: { type: "search", toolName: "web_search", query: "OpenTUI", webResults: [{ title: "docs", url: "https://example.com" }] }, text: 'Web Search "OpenTUI" (1 match)' },
  { detail: { type: "fetch", url: "https://example.com" }, text: "WebFetch https://example.com" },
  { detail: { type: "plain_text", label: "Check", text: "all good\nnext line" }, text: "Check all good next line" },
  { detail: { type: "sub_agent", description: "Find the caller", log: "", actions: [{ index: 0, toolName: "read" }] }, text: "Task Find the caller (1 action)" },
  { detail: { type: "sub_agent", description: "Start exploring", log: "" }, text: "Task Start exploring (0 actions)" },
  { detail: { type: "unknown", input: {}, output: {} }, text: "unknown" },
])("inline tool: $text", async ({ detail, text }) => {
  screen = await testRender(() => <TimelineRow item={tool(detail)} streaming={false} showDetails={false} />, { width: 100, height: 10 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain(text)
  expect(screen.renderer.root.getChildren()[0]?.height).toBe(1)
})

test("plain_text tools whose text repeats the label (Claude task notifications) print it once", async () => {
  screen = await testRender(() => <TimelineRow item={tool({ type: "plain_text", label: "Pause for 5 seconds", text: "Pause for 5 seconds" })} streaming={false} showDetails={false} />, { width: 100, height: 10 })
  await screen.flush()
  expect(screen.captureCharFrame().match(/Pause for 5 seconds/g)).toHaveLength(1)
})

test("write uses the syntax-aware code renderer and a panel", async () => {
  screen = await testRender(() => <TimelineRow item={tool({ type: "write", filePath: "answer.ts", content: "const answer = 42" })} streaming={false} showDetails={false} />, { width: 80, height: 15 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Write answer.ts")
  expect(screen.captureCharFrame()).toContain("const answer = 42")
  const panel = screen.renderer.root.getChildren()[0]!
  const code = panel.getChildren().flatMap((child) => child.getChildren()).find((child) => child instanceof CodeRenderable)
  expect(code instanceof CodeRenderable).toBe(true)
  expect((code as CodeRenderable).syntaxStyle).toBe(syntax())
  expect((code as CodeRenderable).filetype).toBe("typescript")
  expect((panel as BoxRenderable).backgroundColor).toEqual(theme.backgroundPanel)
  await (code as CodeRenderable).highlightingDone
  await screen.flush()
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("const"))?.fg).toEqual(theme.syntaxKeyword)
})

test("plan renders markdown and worktree shows command status and log", async () => {
  screen = await testRender(() => <box>
    <TimelineRow item={tool({ type: "plan", text: "## Next steps\n\nBuild the client" })} streaming={false} showDetails={false} />
    <TimelineRow item={tool({ type: "worktree_setup", worktreePath: "/work/client", branchName: "client-ui", log: "Setup complete", commands: [{ index: 0, command: "git worktree add", cwd: "/work", log: "", status: "completed", exitCode: 0 }] })} streaming={false} showDetails={false} />
  </box>, { width: 80, height: 25 })
  await screen.flush()
  const markdown = screen.renderer.root.getChildren()[0]?.getChildren()[0]?.getChildren().find((child) => child instanceof MarkdownRenderable)
  expect(markdown instanceof MarkdownRenderable).toBe(true)
  await Promise.all(markdown!.getChildren().filter((child): child is CodeRenderable => child instanceof CodeRenderable).map((child) => child.highlightingDone))
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Next steps")
  expect(screen.captureCharFrame()).toContain("Build the client")
  expect(screen.captureCharFrame()).toContain("Worktree client-ui")
  expect(screen.captureCharFrame()).toContain("$ git worktree add (exit 0)")
  expect(screen.captureCharFrame()).toContain("Setup complete")
})

test("running tools spin, failed tools show colored errors, canceled tools are struck through", async () => {
  const original = tool({ type: "read", filePath: "file.txt" })
  const [item, setItem] = createSignal<ToolCallTimelineItem>({ ...original, status: "running" })
  screen = await testRender(() => <TimelineRow item={item()} streaming={false} showDetails={false} />, { width: 80, height: 15 })
  await screen.flush()
  expect(screen.captureCharFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read file.txt/)
  setItem({ ...original, status: "failed", error: "Permission denied" })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Permission denied")
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Permission denied"))?.fg).toEqual(theme.error)
  setItem({ ...original, status: "canceled" })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Read file.txt")
  expect(screen.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("Read file.txt") && (span.attributes & TextAttributes.STRIKETHROUGH) !== 0)).toBe(true)
})

test("assistant streaming updates the existing markdown renderer instead of remounting it", async () => {
  const [text, setText] = createSignal("First chunk")
  screen = await testRender(() => <TimelineRow item={{ type: "assistant_message", text: text() }} streaming showDetails={false} />, { width: 80, height: 15 })
  await screen.flush()
  const markdown = screen.renderer.root.getChildren()[0]?.getChildren()[0]
  expect(markdown).toBeInstanceOf(MarkdownRenderable)
  setText("First chunk, continued")
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("First chunk, continued")
  expect(screen.renderer.root.getChildren()[0]?.getChildren()[0]).toBe(markdown)
})

test("user timestamps are opt-in", async () => {
  const [timestamps, setTimestamps] = createSignal(false)
  const timestamp = new Date(2026, 0, 2, 14, 30).getTime()
  screen = await testRender(() => <TimelineRow item={{ type: "user_message", text: "Hello" }} streaming={false} showDetails={false} timestamp={timestamp} showTimestamps={timestamps()} />, { width: 80, height: 15 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Hello")
  expect(screen.captureCharFrame()).not.toContain(timestampLabel(timestamp))
  setTimestamps(true)
  await screen.flush()
  expect(screen.captureCharFrame()).toContain(timestampLabel(timestamp))
})

test("new permission requests reset answers; malformed options are ignored and no Other is added without permission", async () => {
  const first = request([null, { question: "constructor", options: [null, 42, {}, { label: "Yes" }] }])
  const [current, setCurrent] = createSignal(first)
  const responses: AgentPermissionResponse[] = []
  screen = await testRender(() => <PermissionPrompt request={current()} onRespond={(response) => responses.push(response)} />, { width: 80, height: 20 })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("constructor")
  expect(screen.captureCharFrame()).not.toContain("Other…")
  screen.mockInput.pressEnter()
  await screen.flush()
  expect(responses).toEqual([{ behavior: "allow", updatedInput: { answers: { constructor: "Yes" } } }])
  setCurrent({ ...first, id: "second", input: { questions: [{ question: "constructor", options: ["No"], allowOther: true }] } })
  await screen.flush()
  expect(screen.captureCharFrame()).toContain("Other…")
  screen.mockInput.pressEnter()
  await screen.flush()
  expect(responses[1]).toEqual({ behavior: "allow", updatedInput: { answers: { constructor: "No" } } })
})

test("animations off: spinners show OpenCode's still glyphs and stop redrawing; on resumes them", async () => {
  setPref("animations", false)
  try {
    screen = await testRender(() => <box><Spinner>Thinking</Spinner><PromptSpinner color={theme.agent} /></box>, { width: 40, height: 4 })
    await screen.renderOnce()
    const still = screen.captureCharFrame()
    expect(still).toContain("⋯ Thinking")
    expect(still).toContain("[⋯]")
    await Bun.sleep(250)
    await screen.renderOnce()
    expect(screen.captureCharFrame()).toBe(still)
    setPref("animations", true)
    await Bun.sleep(250)
    await screen.renderOnce()
    expect(screen.captureCharFrame()).not.toContain("⋯")
  } finally {
    setPref("animations", true)
  }
})
