import { ScrollBoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { App } from "../src/app"
import { runCommand } from "../src/commands"
import { setAgents, setTimeline, type PaseoAgent } from "../src/paseo"
import { setAgentId } from "../src/state"

const all = (node: Renderable): Renderable[] => node.getChildren().flatMap((child) => [child, ...all(child)])

// The app's scroll wiring around the transcript's tail-first window, on a fake 300-row session (no daemon).
test("tail-first transcript: wheel reveal holds the viewport, bottom follows the tail, ctrl+g and jumps reveal", async () => {
  const rows = Array.from({ length: 300 }, (_, i) => (i % 2 ? { type: "assistant_message" as const, text: `answer a${i}` } : { type: "user_message" as const, text: `question q${i}` }))
  const screen = await testRender(() => <App />, { width: 100, height: 40 })
  const settle = async (ms = 120) => {
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(ms / 4)
      await screen.renderOnce()
    }
  }
  try {
    setAgents("fake", { id: "fake", provider: "claude", cwd: "/tmp", status: "idle", updatedAt: new Date().toISOString() } as PaseoAgent)
    setAgentId("fake")
    setTimeline({ agentId: "fake", rows, times: rows.map(() => 1000), marks: [], loading: false, hasOlder: false })
    await settle(300)
    const scroll = all(screen.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable && node.content.getChildren().some((child) => child.id.startsWith("row-")))!
    const mounted = () => scroll.content.getChildren().filter((child) => child.id.startsWith("row-")).map((child) => Number(child.id.slice(4)))
    expect(mounted()).toHaveLength(40)
    expect(mounted()[0]).toBe(260)

    // Near the top, each wheel step up moves a fixed row by one line, including the step that mounts the next chunk.
    scroll.scrollTo(scroll.viewport.height + 6)
    await settle()
    const row = () => scroll.content.getChildren().find((child) => child.id === "row-280")!
    const steps: number[] = []
    for (let i = 0; i < 50 && mounted().length === 40; i++) {
      const y = row().y
      await screen.mockMouse.scroll(10, 10, "up")
      await settle(60)
      steps.push(row().y - y)
    }
    expect(mounted()).toHaveLength(100)
    expect(steps.at(-1)).toBe(steps.at(-2)!)

    scroll.scrollTo(scroll.scrollHeight)
    await settle()
    expect(mounted()).toHaveLength(40)

    // From the bottom: revealing must not be undone by the bottom-stuck scroll before it moves.
    screen.mockInput.pressKey("g", { ctrl: true })
    await settle(300)
    expect(mounted()).toHaveLength(300)
    expect(scroll.scrollTop).toBe(0)
    expect(screen.captureCharFrame()).toContain("question q0")

    scroll.scrollTo(scroll.scrollHeight)
    await settle()
    expect(mounted()).toHaveLength(40)
    runCommand("session.timeline")
    await settle()
    await screen.mockInput.typeText("question q16")
    await settle()
    screen.mockInput.pressEnter()
    await settle(300)
    expect(mounted()[0]).toBeLessThan(260)
    expect(screen.captureCharFrame().match(/q(\d+)/)?.[1]).toBe(String(mounted()[0]))
  } finally {
    setAgentId(undefined)
    setTimeline({ agentId: undefined, rows: [], times: [], marks: [] })
    screen.renderer.destroy()
  }
}, 30000)
