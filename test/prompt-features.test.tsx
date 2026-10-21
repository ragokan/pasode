import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender, useKeyboard } from "@opentui/solid"
import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runCommand } from "../src/commands"
import { DialogHost } from "../src/dialog"
import { setAgents, type PaseoAgent } from "../src/paseo"
import { Prompt, type PromptProps, type PromptRef, type PromptSubmit } from "../src/prompt"
import { registerPromptCommands } from "../src/prompt/commands"
import { enqueue, queueOf } from "../src/prompt/queue"
import { popStash, stashList } from "../src/prompt/stash"
import { rendererOptions } from "../src/renderer"
import { setAgentId } from "../src/state"
import { theme } from "../src/theme"

let screen: TestRendererSetup | undefined
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
})

const display = {
  focused: true,
  cwd: "/tmp",
  slashItems: [],
  agent: { label: "Build", color: theme.agent },
  model: { name: "Opus 5.5", provider: "Claude Code" },
  location: "~",
  status: { running: false, interruptArmed: false },
}

/** A Prompt under a host that, like App, sees keys the prompt leaves unhandled (↓ opens the composer there). */
async function mount(props: Partial<PromptProps> = {}) {
  const mounted: { prompt?: PromptRef; downs: number; submissions: [PromptSubmit, { queue?: boolean } | undefined][] } = { downs: 0, submissions: [] }
  function Host() {
    useKeyboard((key) => {
      if (mounted.prompt?.handleKey(key) || key.defaultPrevented) return
      if (key.name === "down") mounted.downs++
    })
    return <Prompt {...display} ref={(ref) => (mounted.prompt = ref)} onSubmit={(input, options) => void mounted.submissions.push([input, options])} {...props} />
  }
  screen = await testRender(Host, { ...rendererOptions, width: 80, height: 24, kittyKeyboard: true })
  await screen.flush()
  return mounted
}

test("↑ and ↓ step through what was sent; ↓ at the newest end is left to the host", async () => {
  const view = await mount()
  for (const text of ["first", "second line one\nsecond line two"]) {
    view.prompt!.setText(text)
    screen!.mockInput.pressEnter()
    await screen!.waitFor(() => view.prompt!.isEmpty())
  }
  await screen!.mockInput.pressKeys(["ARROW_DOWN"])
  expect(view.downs).toBe(1) // empty prompt, newest end: the host's ↓ (composer) still works

  await screen!.mockInput.pressKeys(["ARROW_UP"])
  expect(view.prompt!.text()).toBe("second line one\nsecond line two")
  await screen!.mockInput.pressKeys(["ARROW_DOWN"]) // moves within the recalled text first
  expect(view.prompt!.text()).toBe("second line one\nsecond line two")
  await screen!.mockInput.pressKeys(["ARROW_UP", "ARROW_UP"]) // back to the start of it, then one older
  expect(view.prompt!.text()).toBe("first")
  await screen!.mockInput.pressKeys(["ARROW_DOWN", "ARROW_DOWN"])
  expect(view.prompt!.text()).toBe("second line one\nsecond line two")
  expect(view.downs).toBe(1)
})

test("a draft in progress isn't replaced by ↑", async () => {
  const view = await mount()
  view.prompt!.setText("sent before")
  screen!.mockInput.pressEnter()
  await screen!.waitFor(() => view.prompt!.isEmpty())
  await screen!.mockInput.typeText("typing")
  screen!.mockInput.pressKey("a", { ctrl: true }) // to the start of the line
  await screen!.mockInput.pressKeys(["ARROW_UP"])
  expect(view.prompt!.text()).toBe("typing")
})

test("a big paste shows as a token, goes out in full, and opens in $EDITOR in full", async () => {
  const view = await mount()
  screen!.renderer.start() // async paste handling needs the live loop
  const pasted = "line one\nline two\nline three $& \nline four"
  await screen!.mockInput.typeText("fix this: ")
  await screen!.mockInput.pasteBracketedText(pasted)
  await screen!.waitFor(() => view.prompt!.text().includes("[Pasted ~4 lines]"))
  expect(view.prompt!.text()).toBe("fix this: [Pasted ~4 lines] ")
  await screen!.flush()
  expect(screen!.captureCharFrame()).toContain("[Pasted ~4 lines]")
  expect(screen!.captureCharFrame()).not.toContain("line three")

  const out = path.join(os.tmpdir(), `pasode-editor-out-${process.pid}.txt`)
  const previous = process.env.VISUAL
  process.env.VISUAL = `cp "$1" ${out}; :`
  try {
    await view.prompt!.openEditor()
    expect(await readFile(out, "utf8")).toBe(`fix this: ${pasted} `)
  } finally {
    if (previous === undefined) delete process.env.VISUAL
    else process.env.VISUAL = previous
    await rm(out, { force: true })
  }
  // The editor's text replaces the prompt, tokens included, so nothing is expanded twice.
  expect(view.prompt!.text()).toBe(`fix this: ${pasted} `)

  view.prompt!.clear()
  await screen!.mockInput.pasteBracketedText(pasted)
  await screen!.waitFor(() => view.prompt!.text().startsWith("[Pasted"))
  screen!.mockInput.pressEnter()
  await screen!.waitFor(() => view.submissions.length === 1)
  expect(view.submissions[0]![0]).toEqual({ text: `${pasted} `, images: [] })
  expect(view.prompt!.isEmpty()).toBe(true)
})

test("a short paste stays inline", async () => {
  const view = await mount()
  screen!.renderer.start()
  await screen!.mockInput.pasteBracketedText("just two\nlines")
  await screen!.waitFor(() => view.prompt!.text().includes("lines"))
  expect(view.prompt!.text()).toBe("just two\nlines")
})

test("@ lists paths for the query, and the pick goes in as quoted text", async () => {
  const queries: string[] = []
  const view = await mount({
    suggestFiles: async (query) => {
      queries.push(query)
      return [
        { path: "src/app.tsx", kind: "file" },
        { path: "my docs/a b.md", kind: "file" },
        { path: "src/prompt", kind: "directory" },
      ]
    },
  })
  await screen!.mockInput.typeText("look at @ap")
  await Bun.sleep(300) // the query is debounced
  await screen!.flush()
  expect(queries).toEqual(["ap"])
  let frame = screen!.captureCharFrame()
  expect(frame).toContain("app.tsx")
  expect(frame).toContain("prompt/")
  await screen!.mockInput.pressKeys(["ARROW_DOWN"])
  screen!.mockInput.pressTab()
  await screen!.flush()
  expect(view.prompt!.text()).toBe('look at "my docs/a b.md"')
  expect(view.submissions).toHaveLength(0)

  await screen!.mockInput.typeText(" and @")
  await Bun.sleep(300)
  await screen!.flush()
  screen!.mockInput.pressEscape()
  await screen!.flush()
  expect(screen!.captureCharFrame()).not.toContain("app.tsx")
  expect(view.prompt!.text()).toBe('look at "my docs/a b.md" and @')

  view.prompt!.setText("mail me@host")
  await Bun.sleep(300)
  await screen!.flush()
  expect(queries).toEqual(["ap", ""]) // an email address isn't a mention
})

test("@ does nothing without a suggestion source, and typing on keeps working", async () => {
  const view = await mount()
  await screen!.mockInput.typeText("@src")
  await Bun.sleep(250)
  await screen!.flush()
  expect(view.prompt!.text()).toBe("@src")
  screen!.mockInput.pressEnter()
  await screen!.waitFor(() => view.submissions.length === 1)
})

test("<leader>return's queue delivery reaches the host, and the dock lists what is queued", async () => {
  const view = await mount({ sessionId: "dock-session" })
  view.prompt!.setText("hold this")
  await view.prompt!.submit("queue")
  expect(view.submissions).toEqual([[{ text: "hold this", images: [] }, { queue: true }]])
  expect(view.prompt!.isEmpty()).toBe(true)
  enqueue("dock-session", { text: "hold this\nand more", images: [] })
  enqueue("dock-session", { text: "second", images: [] })
  await screen!.flush()
  expect(screen!.captureCharFrame()).toContain("2 queued · hold this and more")
})

test("stash commands shelve the prompt, restore it onto a draft, and the list dialog restores or deletes", async () => {
  const mounted: { prompt?: PromptRef } = {}
  setAgentId("stash-session")
  setAgents({ "stash-session": { id: "stash-session", status: "idle", pendingPermissions: [] } as unknown as PaseoAgent })
  function Host() {
    registerPromptCommands(() => mounted.prompt)
    return (
      <>
        <Prompt {...display} sessionId="stash-session" ref={(ref) => (mounted.prompt = ref)} onSubmit={() => {}} />
        <DialogHost />
      </>
    )
  }
  screen = await testRender(Host, { ...rendererOptions, width: 80, height: 24, kittyKeyboard: true })
  try {
    await screen.flush()
    while (popStash());
    mounted.prompt!.setText("first thought")
    runCommand("prompt.stash")
    expect(mounted.prompt!.isEmpty()).toBe(true)
    mounted.prompt!.setText("second\nthought")
    runCommand("prompt.stash")
    runCommand("prompt.stash") // empty: nothing to stash
    expect(stashList().map((entry) => entry.text)).toEqual(["first thought", "second\nthought"])

    mounted.prompt!.setText("draft")
    runCommand("prompt.stash.pop")
    await screen.flush()
    expect(mounted.prompt!.text()).toBe("draft\n\nsecond\nthought") // onto the draft, not over it
    expect(stashList()).toHaveLength(1)

    mounted.prompt!.clear()
    runCommand("prompt.stash.list")
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("first thought")
    screen.mockInput.pressKey("d", { ctrl: true })
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("Press ctrl+d again to delete")
    screen.mockInput.pressKey("d", { ctrl: true })
    await screen.flush()
    expect(stashList()).toHaveLength(0)

    mounted.prompt!.setText("kept")
    runCommand("prompt.stash")
    runCommand("prompt.stash.list")
    await screen.flush()
    screen.mockInput.pressEnter()
    await screen.flush()
    expect(mounted.prompt!.text()).toBe("kept")
    expect(stashList()).toHaveLength(0)

    enqueue("stash-session", { text: "queued one", images: [] })
    enqueue("stash-session", { text: "queued two", images: [] })
    runCommand("prompt.queue.list")
    await screen.flush()
    expect(screen.captureCharFrame()).toContain("queued one")
    screen.mockInput.pressKey("d", { ctrl: true })
    await screen.flush()
    expect(queueOf("stash-session").map((item) => item.text)).toEqual(["queued two"])
    screen.mockInput.pressEnter() // pull it back into the prompt
    await screen.flush()
    expect(queueOf("stash-session")).toEqual([])
    expect(mounted.prompt!.text()).toBe("kept\n\nqueued two")
  } finally {
    setAgentId(undefined)
  }
})

test("a late answer for the old workspace can't replace the new workspace's @ results", async () => {
  const [workspace, setWorkspace] = createSignal("mention-a")
  const pending: { workspace: string; resolve: (files: { path: string; kind: "file" }[]) => void }[] = []
  const mounted: { prompt?: PromptRef } = {}
  screen = await testRender(() => (
    <Prompt {...display} ref={(ref) => (mounted.prompt = ref)} sessionId={workspace()} cwd={`/tmp/${workspace()}`} onSubmit={() => {}}
      suggestFiles={() => new Promise((resolve) => pending.push({ workspace: workspace(), resolve }))} />
  ), { ...rendererOptions, width: 80, height: 24, kittyKeyboard: true })
  await screen.flush()
  mounted.prompt!.setText("@src")
  await Bun.sleep(250)
  expect(pending.map((request) => request.workspace)).toEqual(["mention-a"])
  setWorkspace("mention-b")
  await screen.flush()
  mounted.prompt!.setText("@src")
  await Bun.sleep(250)
  expect(pending.map((request) => request.workspace)).toEqual(["mention-a", "mention-b"])
  pending[1]!.resolve([{ path: "b-correct.ts", kind: "file" }])
  await screen.flush()
  pending[0]!.resolve([{ path: "a-stale.ts", kind: "file" }])
  await screen.flush()
  screen.mockInput.pressTab()
  await screen.flush()
  expect(mounted.prompt!.text()).toBe('"b-correct.ts"')
})
