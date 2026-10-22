import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { DialogSelect } from "../src/dialog"

test("search can be hidden; space runs the action on the selected row (OpenCode's /mcps toggle)", async () => {
  const toggled: string[] = []
  const screen = await testRender(
    () => (
      <DialogSelect
        title="MCP servers"
        search={false}
        options={[{ title: "cua", value: "cua" }, { title: "browseros", value: "browseros" }]}
        onSelect={(option) => toggled.push(`enter:${option.value}`)}
        actions={[{ title: "space", label: "disable", match: (key) => key.name === "space", run: (option) => toggled.push(`space:${option.value}`) }]}
      />
    ),
    { width: 60, height: 20 },
  )
  await screen.renderOnce()
  const frame = screen.captureCharFrame()
  expect(frame).not.toContain("Search")
  expect(frame).toContain("space disable")
  screen.mockInput.pressArrow("down")
  screen.mockInput.pressKey(" ")
  screen.mockInput.pressEnter()
  await screen.mockInput.typeText("cua")
  await screen.renderOnce()
  expect(toggled).toEqual(["space:browseros", "enter:browseros"])
  expect(screen.captureCharFrame()).toContain("cua")
  screen.renderer.destroy()
})

test("the selection follows its option when the list reorders; a global action runs on an empty list", async () => {
  const [options, setOptions] = createSignal(["a", "b", "c"].map((value) => ({ title: value, value })))
  const ran: string[] = []
  const screen = await testRender(
    () => (
      <DialogSelect
        title="Reorder"
        options={options()}
        onSelect={(option) => ran.push(`select:${option.value}`)}
        actions={[
          { title: "pick", label: "ctrl+k", match: (key) => key.ctrl && key.name === "k", run: (option) => ran.push(`pick:${option.value}`) },
          { title: "tab", label: "tab", match: (key) => key.name === "tab", run: () => ran.push("tab"), global: true },
        ]}
      />
    ),
    { width: 60, height: 20 },
  )
  await screen.renderOnce()
  screen.mockInput.pressArrow("down") // b
  setOptions(["c", "b", "a"].map((value) => ({ title: value, value })))
  await screen.renderOnce()
  screen.mockInput.pressKey("k", { ctrl: true })
  setOptions([])
  await screen.renderOnce()
  screen.mockInput.pressKey("k", { ctrl: true }) // nothing selected: a row action doesn't run
  screen.mockInput.pressTab()
  expect(ran).toEqual(["pick:b", "tab"])
  screen.renderer.destroy()
})

/** A DialogSelect whose options the test replaces while it is open. */
async function liveList(size = { width: 60, height: 20 }) {
  const [options, setOptions] = createSignal<{ title: string; value: string }[]>([])
  const picked: string[] = []
  const screen = await testRender(() => <DialogSelect title="live" options={options()} onSelect={(option) => picked.push(option.value)} />, size)
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(10)
      await screen.renderOnce()
    }
  }
  await settle()
  return { screen, picked, settle, set: (values: string[]) => setOptions(values.map((value) => ({ title: value, value }))) }
}

test("a list that fills after opening anchors its selection on the first option, so a reorder keeps it", async () => {
  const { screen, picked, settle, set } = await liveList()
  set(["a", "b"])
  await settle()
  set(["b", "a"])
  await settle()
  screen.mockInput.pressEnter()
  expect(picked).toEqual(["a"])
  screen.renderer.destroy()
})

test("when the selected option disappears the neighbour that takes its place is anchored, and follows later reorders", async () => {
  const { screen, picked, settle, set } = await liveList()
  set(["a", "b", "c"])
  await settle()
  screen.mockInput.pressArrow("down") // b
  set(["a", "c"]) // b is gone: c is now on its row
  await settle()
  screen.mockInput.pressEnter()
  set(["c", "a"])
  await settle()
  screen.mockInput.pressEnter()
  expect(picked).toEqual(["c", "c"])
  screen.renderer.destroy()
})

test("a selection that is reordered out of the viewport is scrolled back into view", async () => {
  const values = Array.from({ length: 25 }, (_, i) => `Session ${String(i).padStart(2, "0")}`)
  const { screen, picked, settle, set } = await liveList({ width: 60, height: 24 })
  set(values)
  await settle()
  set([...values.slice(1), values[0]!]) // the selected first option moves to the bottom
  await settle()
  expect(screen.captureCharFrame()).toContain("Session 00")
  screen.mockInput.pressEnter()
  expect(picked).toEqual(["Session 00"])
  screen.renderer.destroy()
})
