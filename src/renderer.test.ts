import { expect, test } from "bun:test"
import { quit } from "./renderer"

test("quit turns mouse reporting off and destroys only after in-flight reports had time to arrive", async () => {
  const log: string[] = []
  const renderer = { useMouse: true, destroy: () => log.push(`destroy, mouse ${renderer.useMouse ? "on" : "off"}`) }
  quit(renderer, 20)
  expect(renderer.useMouse).toBe(false)
  expect(log).toEqual([])
  await Bun.sleep(40)
  expect(log).toEqual(["destroy, mouse off"])
})

test("quit without mouse reporting destroys at once", () => {
  const log: string[] = []
  quit({ useMouse: false, destroy: () => log.push("destroy") })
  expect(log).toEqual(["destroy"])
})
