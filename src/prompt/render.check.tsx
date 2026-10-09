import { expect, spyOn, test } from "bun:test"
import { ImageRenderable, TextAttributes } from "@opentui/core"
import { testRender, useKeyboard } from "@opentui/solid"
import { createSignal } from "solid-js"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Prompt, type PromptRef, type PromptSubmit } from "./index"
import { theme } from "../theme"
import { blocksFrame } from "./spinner"

const display = {
  agent: { label: "Build", color: theme.agent },
  model: { name: "Opus 5.5", provider: "Claude Code", variant: "xhigh" },
  location: "~/coding/x:main",
  status: { running: false, interruptArmed: false },
}
const image = { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" }

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
    return <Prompt {...display} focused cwd={process.cwd()}
      slashItems={[{ name: "local", description: "Local action", run: () => localRuns++ }, { name: "remote", description: "Agent command" }]}
      footerRight={<text>commands</text>}
      ref={(api) => prompt = api}
      onSubmit={(value) => { submissions.push(value); throw new Error("Test rejection") }} />
  }
  const screen = await testRender(Host, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 Claude Code · xhigh")
    expect(screen.captureCharFrame()).toContain("~/coding/x:main")
    expect(screen.captureCharFrame()).toContain("commands")
    expect(screen.captureCharFrame()).toMatch(/Ask anything… "(Fix a TODO in the codebase|What is the tech stack of this project\?|Fix broken tests)"/)
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
    expect(submissions[0]).toEqual({ text: "/r", images: [] })
    expect(prompt?.text()).toBe("/r")
    await screen.waitForFrame((frame) => frame.includes("Test rejection"))
  } finally {
    screen.renderer.destroy()
  }
  expect(prompt).toBeUndefined()
})

test("prompt inserts modified-enter newlines", async () => {
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()}
    slashItems={[]} footerRight={<text>commands</text>} ref={(api) => prompt = api}
    onSubmit={(value) => { submissions.push(value); throw new Error("Not sent") }} />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    await screen.mockInput.typeText("one")
    screen.mockInput.pressEnter({ shift: true })
    await screen.mockInput.typeText("two")
    screen.mockInput.pressEnter({ ctrl: true })
    await screen.mockInput.typeText("three")
    screen.mockInput.pressKey("j", { ctrl: true })
    await screen.mockInput.typeText("four")
    screen.mockInput.pressEnter({ meta: true })
    await screen.mockInput.typeText("five")
    await screen.flush()
    expect(prompt?.text()).toBe("one\ntwo\nthree\nfour\nfive")
    expect(submissions).toHaveLength(0)
  } finally {
    screen.renderer.destroy()
  }
})

test("punctuation is literal, submission preserves whitespace and arrows only move the cursor", async () => {
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()}
    slashItems={[]} footerRight={<text>commands</text>} ref={(api) => prompt = api} onSubmit={(value) => { submissions.push(value) }} />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    const text = "!pwd @src/app.ts  "
    await screen.mockInput.typeText(text)
    await screen.flush()
    expect(prompt?.text()).toBe(text)
    expect(screen.captureCharFrame()).toContain("Build · Opus 5.5 Claude Code · xhigh")
    expect(screen.captureCharFrame()).toContain("commands")
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text, images: [] })
    await screen.flush()
    expect(prompt?.isEmpty()).toBe(true)
    await screen.mockInput.pressKeys(["ARROW_UP", "ARROW_DOWN"])
    expect(prompt?.isEmpty()).toBe(true)
    prompt?.setText("  好\nnew draft  \n")
    await screen.mockInput.pressKeys(["ARROW_UP", "ARROW_DOWN"])
    expect(prompt?.text()).toBe("  好\nnew draft  \n")
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 2)
    expect(submissions[1]).toEqual({ text: "  好\nnew draft  \n", images: [] })
  } finally {
    screen.renderer.destroy()
  }
})

test("openEditor suspends/resumes the renderer and accepts edits, including an empty file", async () => {
  let prompt: PromptRef | undefined
  const previousVisual = process.env.VISUAL
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()}
    slashItems={[]} ref={(api) => prompt = api} onSubmit={() => { throw new Error("No submit expected") }} />, { width: 80, height: 24 })
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
    expect(screen.captureCharFrame()).toContain("Ask anything…")
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

test("OpenCode frame and responsive metadata", async () => {
  let prompt: PromptRef | undefined
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()} slashItems={[]} ref={(api) => prompt = api} onSubmit={() => {}} />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    const rows = screen.captureCharFrame().split("\n")
    expect(rows[0]?.trimEnd()).toBe("┃")
    expect(rows[1]).toMatch(/^┃  Ask anything… "/)
    expect(rows[2]?.trimEnd()).toBe("┃")
    expect(rows[3]?.trimEnd()).toBe("┃  Build · Opus 5.5 Claude Code · xhigh")
    expect(rows[4]).toBe(`╹${"▀".repeat(79)}`)
    expect(rows[5]?.trimEnd()).toBe(display.location)
    const spans = screen.captureSpans().lines[3]!.spans
    expect(spans.find((span) => span.text.includes("Build"))?.fg).toEqual(display.agent.color)
    expect(spans.find((span) => span.text.includes("xhigh"))?.attributes! & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    screen.resize(40, 24)
    await screen.flush()
    const narrow = screen.captureCharFrame()
    expect(narrow).not.toContain("Build")
    expect(narrow).not.toContain("Claude Code")
    expect(narrow).toContain("Opus 5.5 · xhigh")
    expect(narrow.split("\n")[1]).toMatch(/^┃ Ask anything… "/)
    expect(prompt?.isEmpty()).toBe(true)
  } finally {
    screen.renderer.destroy()
  }
})

test("running footer switches interrupt status and restores location", async () => {
  const [status, setStatus] = createSignal({ running: true, interruptArmed: false })
  const screen = await testRender(() => <Prompt {...display} status={status()} focused cwd={process.cwd()} slashItems={[]} onSubmit={() => {}} />, { width: 80, height: 24 })
  try {
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("esc interrupt")
    expect(screen.captureCharFrame()).toContain("■")
    expect(screen.captureCharFrame()).not.toContain(display.location)
    setStatus({ running: true, interruptArmed: true })
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("esc again to interrupt")
    const armed = screen.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("esc again to interrupt"))
    expect(armed?.fg).toEqual(theme.warning)
    setStatus({ running: false, interruptArmed: false })
    await screen.flush()
    expect(screen.captureCharFrame()).toContain(display.location)
    expect(screen.captureCharFrame()).not.toContain("interrupt")
  } finally {
    screen.renderer.destroy()
  }
})

test("image file paste previews native attachments and preserves exact text on submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-prompt-images-test-"))
  const file = path.join(directory, "test image.png")
  await writeFile(file, Buffer.from(image.data, "base64"))
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  let reject = true
  const screen = await testRender(() => <Prompt {...display} focused cwd={directory} slashItems={[]} ref={(api) => prompt = api}
    onSubmit={(value) => { submissions.push(value); if (reject) throw new Error("Keep draft") }} />, { width: 80, height: 24 })
  try {
    // Async filesystem pastes need the live loop; test waiters stop at render-idle.
    screen.renderer.start()
    await screen.flush()
    const text = "  好 tail  \n"
    prompt?.setText(text)
    await screen.mockInput.pasteBracketedText(`"${file}"`)
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-preview-0"))
    const preview = screen.renderer.root.findDescendantById("prompt-image-preview-0") as ImageRenderable
    await preview.loadPromise
    expect(preview.image?.width).toBe(1)
    expect(preview.source).toBe(`data:${image.mimeType};base64,${image.data}`)
    expect(preview.fit).toBe("cover")
    expect(preview.protocol).toBe("auto")
    await screen.flush()
    const thumbnail = screen.renderer.root.findDescendantById("prompt-image-0")!
    expect(thumbnail.width).toBe(12)
    expect(thumbnail.height).toBe(6)
    expect(screen.captureCharFrame()).toContain("click image to remove")
    expect(prompt?.text()).toBe(text)
    await screen.mockInput.pasteBracketedText(file.replaceAll(" ", "\\ "))
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-1"))
    await screen.mockInput.pasteBracketedText(new URL(`file://${file}`).href)
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-2"))
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text, images: [image, image, image] })
    expect(prompt?.text()).toBe(text)
    expect(screen.renderer.root.findDescendantById("prompt-image-2")).toBeDefined()
    reject = false
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 2)
    await screen.flush()
    expect(submissions[1]).toEqual({ text, images: [image, image, image] })
    expect(prompt?.isEmpty()).toBe(true)
    expect(screen.renderer.root.findDescendantById("prompt-image-0")).toBeUndefined()
  } finally {
    screen.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
})

test("clipboard images preview without modifying text and support click and empty-backspace removal", async () => {
  const clipboard = await import("./clipboard")
  const read = spyOn(clipboard, "readClipboard").mockResolvedValue({ image })
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()} slashItems={[]} ref={(api) => prompt = api}
    onSubmit={(value) => { submissions.push(value); throw new Error("Keep draft") }} />, { width: 80, height: 24 })
  try {
    await screen.flush()
    prompt?.setText("draft ")
    screen.mockInput.pressKey("v", { ctrl: true })
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-preview-0"))
    const preview = screen.renderer.root.findDescendantById("prompt-image-preview-0") as ImageRenderable
    await preview.loadPromise
    expect(preview.image?.width).toBe(1)
    expect(prompt?.text()).toBe("draft ")
    await screen.flush()
    const thumbnail = screen.renderer.root.findDescendantById("prompt-image-0")!
    await screen.mockMouse.click(thumbnail.x + 1, thumbnail.y + 1)
    await screen.flush()
    expect(screen.renderer.root.findDescendantById("prompt-image-0")).toBeUndefined()
    expect(prompt?.text()).toBe("draft ")

    screen.mockInput.pressKey("v", { ctrl: true })
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-0"))
    screen.mockInput.pressBackspace()
    await screen.flush()
    expect(prompt?.text()).toBe("draft")
    expect(screen.renderer.root.findDescendantById("prompt-image-0")).toBeDefined()
    prompt?.setText("")
    screen.mockInput.pressBackspace()
    await screen.flush()
    expect(prompt?.isEmpty()).toBe(true)
    expect(screen.renderer.root.findDescendantById("prompt-image-0")).toBeUndefined()

    screen.mockInput.pressKey("v", { ctrl: true })
    await screen.waitFor(() => !!screen.renderer.root.findDescendantById("prompt-image-0"))
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text: "", images: [image] })
  } finally {
    read.mockRestore()
    screen.renderer.destroy()
  }
})

test("preview failures show a fallback, extra attachments overflow and backspace removes the last image", async () => {
  const clipboard = await import("./clipboard")
  const attachments = Array.from({ length: 4 }, (_, index) => ({ data: Buffer.from(`invalid-${index}`).toString("base64"), mimeType: "image/png" }))
  const read = spyOn(clipboard, "readClipboard")
  for (const image of attachments) read.mockResolvedValueOnce({ image })
  let prompt: PromptRef | undefined
  const submissions: PromptSubmit[] = []
  const screen = await testRender(() => <Prompt {...display} focused cwd={process.cwd()} slashItems={[]} ref={(api) => prompt = api}
    onSubmit={(value) => { submissions.push(value); throw new Error("Keep draft") }} />, { width: 80, height: 24 })
  try {
    await screen.flush()
    for (let index = 0; index < attachments.length; index++) {
      screen.mockInput.pressKey("v", { ctrl: true })
      if (index < 3) {
        await screen.waitFor(() => !!screen.renderer.root.findDescendantById(`prompt-image-${index}`))
        const preview = screen.renderer.root.findDescendantById(`prompt-image-preview-${index}`) as ImageRenderable | undefined
        await preview?.loadPromise
      }
      await screen.flush()
    }
    expect(prompt?.text()).toBe("")
    expect(prompt?.isEmpty()).toBe(false)
    const frame = screen.captureCharFrame()
    expect(frame.match(/No preview/g)).toHaveLength(3)
    expect(frame).toContain("+1 more")
    expect(screen.renderer.root.findDescendantById("prompt-image-3")).toBeUndefined()
    screen.resize(80, 40)
    await screen.flush()
    expect(screen.renderer.root.findDescendantById("prompt-image-0")?.height).toBe(8)
    expect(screen.renderer.root.findDescendantById("prompt-image-0")?.width).toBe(16)
    screen.resize(80, 16)
    await screen.flush()
    expect(screen.renderer.root.findDescendantById("prompt-image-0")?.height).toBe(4)
    expect(screen.renderer.root.findDescendantById("prompt-image-0")?.width).toBe(8)
    screen.mockInput.pressBackspace()
    await screen.flush()
    expect(screen.captureCharFrame()).not.toContain("+1 more")
    screen.mockInput.pressEnter()
    await screen.waitFor(() => submissions.length === 1)
    expect(submissions[0]).toEqual({ text: "", images: attachments.slice(0, 3) })
    prompt?.clear()
    await screen.flush()
    expect(prompt?.isEmpty()).toBe(true)
    expect(screen.captureCharFrame()).not.toContain("No preview")
  } finally {
    read.mockRestore()
    screen.renderer.destroy()
  }
})

test("blocks spinner uses OpenCode's forward, hold, reverse and fading frames", () => {
  const text = (frame: number) => blocksFrame(frame, theme.agent).map((block) => block.text).join("")
  expect(text(0)).toBe("■⬝⬝⬝⬝⬝⬝⬝")
  expect(text(7)).toBe("⬝⬝■■■■■■")
  expect(text(17)).toBe("⬝⬝⬝⬝⬝⬝■■")
  expect(text(24)).toBe("■■■■■■⬝⬝")
  expect(text(53)).toBe("⬝⬝⬝⬝⬝⬝⬝⬝")
  expect(text(54)).toBe(text(0))
  expect(blocksFrame(0, theme.agent)[0]!.color.a).toBe(1)
  expect(blocksFrame(0, theme.agent)[1]!.color.a).toBeCloseTo(0.18)
})
