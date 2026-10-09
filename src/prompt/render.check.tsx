import { expect, test } from "bun:test"
import { testRender, useKeyboard } from "@opentui/solid"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Prompt, type PromptRef, type PromptSubmit } from "./index"
import { listFiles } from "./autocomplete"

test("prompt renders its footer and owns autocomplete before host shortcuts", async () => {
  let prompt: PromptRef | undefined
  let localRuns = 0
  let hostTabs = 0
  const submissions: PromptSubmit[] = []
  function Host() {
    useKeyboard((key) => {
      if (prompt?.handleKey(key) || key.defaultPrevented) return
      if (key.name === "tab") hostTabs++
    })
    return <Prompt focused placeholder="Send a message…" cwd={process.cwd()}
      slashItems={[{ name: "local", description: "Local action", run: () => localRuns++ }, { name: "remote", description: "Agent command" }]}
      footer={<><text>Plan</text><text>model</text><text>provider</text></>}
      ref={(api) => prompt = api}
      onSubmit={(value) => { submissions.push(value); throw new Error("Test rejection") }} />
  }
  const screen = await testRender(Host, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("Plan model provider")
    await screen.mockInput.typeText("/r")
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("/remote")
    screen.mockInput.pressTab()
    await screen.flush()
    expect(prompt?.text()).toBe("/remote ")
    expect(hostTabs).toBe(0)
    expect(submissions).toHaveLength(0)

    prompt?.setText("/l")
    await screen.flush()
    screen.mockInput.pressEnter()
    await screen.flush()
    expect(localRuns).toBe(1)
    expect(prompt?.isEmpty()).toBe(true)

    prompt?.setText("/r")
    await screen.flush()
    screen.mockInput.pressEscape()
    await screen.flush()
    expect(prompt?.text()).toBe("/r")
    expect(screen.captureCharFrame()).not.toContain("Agent command")
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text: "/r", mode: "normal", images: [] })
    expect(prompt?.text()).toBe("/r")
    await screen.waitForFrame((frame) => frame.includes("Test rejection"))
  } finally {
    screen.renderer.destroy()
  }
  expect(prompt).toBeUndefined()
})

test("prompt switches shell mode, retains failed commands, and inserts modified-enter newlines", async () => {
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  const screen = await testRender(() => <Prompt focused placeholder="Normal placeholder" cwd={process.cwd()}
    slashItems={[]} footer={<text>model</text>} ref={(api) => prompt = api}
    onSubmit={(value) => { submissions.push(value); throw new Error("Not sent") }} />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    await screen.mockInput.typeText("!")
    await screen.flush()
    expect(prompt?.text()).toBe("")
    expect(screen.captureCharFrame()).toContain("Run a shell command…")
    expect(screen.captureCharFrame()).toContain("Shell model")
    screen.mockInput.pressBackspace()
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("Normal placeholder")
    await screen.mockInput.typeText("!pwd")
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text: "pwd", mode: "shell", images: [] })
    expect(prompt?.text()).toBe("pwd")

    prompt?.clear()
    await screen.mockInput.typeText("one")
    screen.mockInput.pressEnter({ shift: true })
    await screen.mockInput.typeText("two")
    screen.mockInput.pressEnter({ ctrl: true })
    await screen.mockInput.typeText("three")
    screen.mockInput.pressKey("j", { ctrl: true })
    await screen.mockInput.typeText("four")
    await screen.flush()
    expect(prompt?.text()).toBe("one\ntwo\nthree\nfour")
    expect(submissions).toHaveLength(1)
  } finally {
    screen.renderer.destroy()
  }
})

test("file completion preserves text around a cursor-local Unicode mention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-prompt-files-test-"))
  let prompt: PromptRef | undefined
  await mkdir(path.join(directory, "src"))
  await writeFile(path.join(directory, "src", "app.ts"), "")
  await listFiles(directory)
  const screen = await testRender(() => <Prompt focused placeholder="Message" cwd={directory}
    slashItems={[]} footer={<text>model</text>} ref={(api) => prompt = api} onSubmit={() => { throw new Error("No submit expected") }} />, { width: 80, height: 24 })
  try {
    await screen.flush()
    prompt?.setText("好 @sap tail")
    await screen.mockInput.pressKeys(["ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT", "ARROW_LEFT"])
    const editor = screen.renderer.currentFocusedEditor!
    expect(editor.getTextRange(0, editor.cursorOffset)).toBe("好 @sap")
    await screen.waitForFrame((frame) => frame.includes("@src/app.ts"))
    screen.mockInput.pressTab()
    await screen.flush()
    expect(prompt?.text()).toBe("好 @src/app.ts  tail")
  } finally {
    screen.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("openEditor suspends/resumes the renderer and accepts edits, including an empty file", async () => {
  let prompt: PromptRef | undefined
  const previousVisual = process.env.VISUAL
  const screen = await testRender(() => <Prompt focused placeholder="Message" cwd={process.cwd()}
    slashItems={[]} footer={<text>model</text>} ref={(api) => prompt = api} onSubmit={() => { throw new Error("No submit expected") }} />, { width: 80, height: 24 })
  try {
    await screen.flush()
    prompt?.setText("draft")
    process.env.VISUAL = "printf edited >"
    await prompt?.openEditor()
    await screen.flush()
    expect(prompt?.text()).toBe("edited")
    process.env.VISUAL = ": >"
    await prompt?.openEditor()
    await screen.flush()
    expect(prompt?.isEmpty()).toBe(true)
    expect(screen.captureCharFrame()).toContain("Message")
    prompt?.setText("recoverable draft")
    process.env.VISUAL = "false"
    const failure = await prompt!.openEditor().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const backup = (failure as Error).message.match(/draft saved at (.+)$/)?.[1]
    expect(backup).toBeDefined()
    try {
      expect(await readFile(backup!, "utf8")).toBe("recoverable draft")
      expect(prompt?.text()).toBe("recoverable draft")
      await screen.flush()
      expect(screen.captureCharFrame()).toContain("recoverable draft")
    } finally {
      await rm(path.dirname(backup!), { recursive: true, force: true })
    }
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL
    else process.env.VISUAL = previousVisual
    screen.renderer.destroy()
  }
})
