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
