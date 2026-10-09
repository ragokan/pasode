import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
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
