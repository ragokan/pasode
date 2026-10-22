import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { afterEach, expect, spyOn, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { Prompt, type PromptRef } from "../src/prompt"
import * as clipboard from "../src/prompt/clipboard"
import { rendererOptions } from "../src/renderer"
import { theme } from "../src/theme"

let screen: TestRendererSetup | undefined
afterEach(() => {
  screen?.renderer.destroy()
  screen = undefined
})

const image = { data: "iVBORw0KGgo=", mimeType: "image/png" }

function mount(initial: string | undefined) {
  const [sessionId, setSessionId] = createSignal<string | undefined>(initial)
  const mounted: { prompt?: PromptRef } = {}
  const view = () => (
    <Prompt
      ref={(ref) => (mounted.prompt = ref)}
      focused
      sessionId={sessionId()}
      cwd="/tmp"
      slashItems={[]}
      agent={{ label: "Build", color: theme.agent }}
      model={{ name: "Opus 5.5", provider: "Claude Code" }}
      location="~"
      status={{ running: false, interruptArmed: false }}
      onSubmit={() => {}}
    />
  )
  return { mounted, sessionId, setSessionId, view }
}

test("an unsent draft stays with its session instead of following you to another one", async () => {
  const { mounted, setSessionId, view } = mount("carry-a")
  screen = await testRender(view, { ...rendererOptions, width: 80, height: 24 })
  await screen.flush()
  await screen.mockInput.typeText("draft for a")
  mounted.prompt!.restore({ ...mounted.prompt!.snapshot(), images: [image] })
  setSessionId("carry-b")
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("")
  expect(mounted.prompt?.isEmpty()).toBe(true)

  await screen.mockInput.typeText("draft for b")
  setSessionId(undefined)
  await screen.flush()
  expect(mounted.prompt?.isEmpty()).toBe(true)
  await screen.mockInput.typeText("home draft")

  setSessionId("carry-a")
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("draft for a")
  expect(mounted.prompt?.snapshot().images).toEqual([image])
  setSessionId("carry-b")
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("draft for b")
  setSessionId(undefined)
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("home draft")
})

test("the draft survives the prompt unmounting, as the home screen's does when a session opens", async () => {
  const [home, setHome] = createSignal(true)
  const mounted: { prompt?: PromptRef } = {}
  const view = () => (
    <>
      {home() ? <HomePrompt /> : <SessionPrompt />}
    </>
  )
  const props = {
    focused: true,
    cwd: "/tmp",
    slashItems: [],
    agent: { label: "Build", color: theme.agent },
    model: { name: "Opus 5.5", provider: "Claude Code" },
    location: "~",
    status: { running: false, interruptArmed: false },
    onSubmit: () => {},
  }
  const HomePrompt = () => <Prompt {...props} ref={(ref) => (mounted.prompt = ref)} />
  const SessionPrompt = () => <Prompt {...props} sessionId="c" ref={(ref) => (mounted.prompt = ref)} />
  screen = await testRender(view, { ...rendererOptions, width: 80, height: 24 })
  await screen.flush()
  await screen.mockInput.typeText("typed at home")
  setHome(false)
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("")
  setHome(true)
  await screen.flush()
  expect(mounted.prompt?.text()).toBe("typed at home")
})

test("a message being sent from the home prompt leaves no draft behind when it unmounts for the new session", async () => {
  const [home, setHome] = createSignal(true)
  const mounted: { prompt?: PromptRef } = {}
  const sent: string[] = []
  const props = {
    focused: true,
    cwd: "/tmp",
    slashItems: [],
    agent: { label: "Build", color: theme.agent },
    model: { name: "Opus 5.5", provider: "Claude Code" },
    location: "~",
    status: { running: false, interruptArmed: false },
    // Like App's first message: it creates the session and navigates, which unmounts this prompt mid-send.
    onSubmit: (input: { text: string }) => { sent.push(input.text); setHome(false) },
  }
  const view = () => (home() ? <Prompt {...props} ref={(ref) => (mounted.prompt = ref)} /> : <Prompt {...props} sessionId="new" ref={(ref) => (mounted.prompt = ref)} />)
  screen = await testRender(view, { ...rendererOptions, width: 80, height: 24 })
  await screen.flush()
  await screen.mockInput.typeText("first message")
  screen.mockInput.pressEnter()
  await screen.waitFor(() => sent.length === 1)
  await screen.flush()
  expect(mounted.prompt?.isEmpty()).toBe(true)
  setHome(true)
  await screen.flush()
  expect(mounted.prompt?.isEmpty()).toBe(true)
})

for (const outcome of ["fails", "succeeds"]) {
  test(`a send that ${outcome} after you switched sessions ${outcome === "fails" ? "returns its draft to its own session" : "leaves nothing behind"}`, async () => {
    const [sessionId, setSessionId] = createSignal<string | undefined>(`${outcome}-a`)
    const mounted: { prompt?: PromptRef } = {}
    let finish!: () => void
    const sending = new Promise<void>((resolve, reject) => (finish = outcome === "fails" ? () => reject(new Error("daemon down")) : resolve))
    sending.catch(() => {})
    screen = await testRender(() => (
      <Prompt ref={(ref) => (mounted.prompt = ref)} focused sessionId={sessionId()} cwd="/tmp" slashItems={[]} agent={{ label: "Build", color: theme.agent }}
        model={{ name: "Opus 5.5", provider: "Claude Code" }} location="~" status={{ running: false, interruptArmed: false }} onSubmit={() => sending} />
    ), { ...rendererOptions, width: 80, height: 24 })
    await screen.flush()
    await screen.mockInput.typeText("slow message")
    screen.mockInput.pressEnter()
    await screen.flush()
    setSessionId(`${outcome}-b`)
    await screen.flush()
    expect(mounted.prompt?.isEmpty()).toBe(true)
    finish()
    await Bun.sleep(10)
    await screen.flush()
    expect(mounted.prompt?.isEmpty()).toBe(true) // b's input is never touched by a's result
    setSessionId(`${outcome}-a`)
    await screen.flush()
    expect(mounted.prompt?.text()).toBe(outcome === "fails" ? "slow message" : "")
  })
}

/** A Prompt whose host takes `sending` to answer a send, switchable between sessions. */
async function mountSending(first: string, onSubmit: (input: { text: string }, id: string) => unknown) {
  const [sessionId, setSessionId] = createSignal(first)
  const mounted: { prompt?: PromptRef } = {}
  screen = await testRender(() => (
    <Prompt ref={(ref) => (mounted.prompt = ref)} focused sessionId={sessionId()} cwd="/tmp" slashItems={[]} agent={{ label: "Build", color: theme.agent }}
      model={{ name: "Opus 5.5", provider: "Claude Code" }} location="~" status={{ running: false, interruptArmed: false }} onSubmit={(input) => onSubmit(input, sessionId()) as void} />
  ), { ...rendererOptions, width: 80, height: 24 })
  await screen.flush()
  return { mounted, setSessionId }
}

test("a submit still waiting on a paste doesn't send the draft of the session you switched to", async () => {
  let finishPaste!: (value: { text: string }) => void
  const read = spyOn(clipboard, "readClipboard").mockImplementation(() => new Promise((resolve) => (finishPaste = resolve)))
  try {
    const sent: string[] = []
    const { mounted, setSessionId } = await mountSending("late-paste-a", (input, id) => sent.push(`${id}:${input.text}`))
    mounted.prompt!.setText("A draft")
    screen!.mockInput.pressKey("v", { ctrl: true })
    await screen!.flush()
    const sending = mounted.prompt!.submit()
    setSessionId("late-paste-b")
    await screen!.flush()
    mounted.prompt!.setText("B private draft")
    finishPaste({ text: "paste for A" })
    await sending
    expect(sent).toEqual([])
    expect(mounted.prompt!.text()).toBe("B private draft")
    setSessionId("late-paste-a")
    await screen!.flush()
    expect(mounted.prompt!.text()).toBe("A draft") // kept as A's draft, unsent
  } finally {
    read.mockRestore()
  }
})

test("edits made while a message is being sent survive switching away and back", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => (finish = resolve))
  const { mounted, setSessionId } = await mountSending("edit-during-a", () => pending)
  mounted.prompt!.setText("message sent")
  const sending = mounted.prompt!.submit()
  await screen!.flush()
  mounted.prompt!.setText("next unsent draft")
  setSessionId("edit-during-b")
  await screen!.flush()
  finish()
  await sending
  setSessionId("edit-during-a")
  await screen!.flush()
  expect(mounted.prompt!.text()).toBe("next unsent draft")
})

test("a failed send comes back into the input when you returned to its session before it failed", async () => {
  let fail!: (error: Error) => void
  const pending = new Promise<void>((_, reject) => (fail = reject))
  const { mounted, setSessionId } = await mountSending("fail-return-a", () => pending)
  mounted.prompt!.setText("do not lose this message")
  const sending = mounted.prompt!.submit()
  await screen!.flush()
  setSessionId("fail-return-b")
  await screen!.flush()
  setSessionId("fail-return-a")
  await screen!.flush()
  expect(mounted.prompt!.isEmpty()).toBe(true) // what is being sent isn't a draft
  await mounted.prompt!.restore({ ...mounted.prompt!.snapshot(), text: "typed since" })
  fail(new Error("daemon disconnected"))
  await sending
  await screen!.flush()
  expect(mounted.prompt!.text()).toBe("typed since\n\ndo not lose this message")
  setSessionId("fail-return-b")
  await screen!.flush()
  setSessionId("fail-return-a")
  await screen!.flush()
  expect(mounted.prompt!.text()).toBe("typed since\n\ndo not lose this message")
})

test("a failed send comes back after its session was left for home and reopened (a different Prompt instance)", async () => {
  const [sessionId, setSessionId] = createSignal<string | undefined>("remount-a")
  const mounted: { prompt?: PromptRef } = {}
  let fail!: (error: Error) => void
  const pending = new Promise<void>((_, reject) => (fail = reject))
  const props = {
    focused: true,
    cwd: "/tmp",
    slashItems: [],
    agent: { label: "Build", color: theme.agent },
    model: { name: "Opus 5.5", provider: "Claude Code" },
    location: "~",
    status: { running: false, interruptArmed: false },
    ref: (ref: PromptRef | undefined) => (mounted.prompt = ref),
    onSubmit: () => pending,
  }
  // Like App: the session prompt and the home prompt are separate instances.
  screen = await testRender(() => (
    <Show when={sessionId()} fallback={<Prompt {...props} />}>
      <Prompt {...props} sessionId={sessionId()} />
    </Show>
  ), { ...rendererOptions, width: 80, height: 24 })
  await screen.flush()
  mounted.prompt!.setText("keep failed message")
  const sending = mounted.prompt!.submit()
  await screen.flush()
  setSessionId(undefined)
  await screen.flush()
  setSessionId("remount-a")
  await screen.flush()
  fail(new Error("daemon disconnected"))
  await sending
  await screen.flush()
  expect(mounted.prompt!.text()).toBe("keep failed message")
  setSessionId(undefined)
  await screen.flush()
  setSessionId("remount-a")
  await screen.flush()
  expect(mounted.prompt!.text()).toBe("keep failed message")
})
