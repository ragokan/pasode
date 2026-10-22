import { expect, test } from "bun:test"
import { isSessionId, parseArgs } from "./args"

const id = "8c5b046e-5881-4a7d-b97c-7c54d940d5b6"

test("session IDs are Paseo agent IDs or the 7+ character prefixes `paseo ls` prints", () => {
  for (const good of [id, "8c5b046", "8c5b046e", "8c5b046e-5881", id.slice(0, 20)]) expect(isSessionId(good)).toBe(true)
  for (const bad of ["update", "updte", "upgrade", "cafe", "decade", "8c5b04", "8C5B046", "8c5b046g", "8c5b046e5881", `${id}0`, "--foo", ""]) expect(isSessionId(bad)).toBe(false)
})

test("only the documented forms parse; everything else is a usage error", () => {
  expect(parseArgs([])).toEqual({ run: "tui" })
  expect(parseArgs([id])).toEqual({ run: "tui", session: id })
  expect(parseArgs(["8c5b046"])).toEqual({ run: "tui", session: "8c5b046" })
  expect(parseArgs(["-s", "8c5b046"])).toEqual({ run: "tui", session: "8c5b046" })
  expect(parseArgs(["--session", id])).toEqual({ run: "tui", session: id })
  for (const flag of ["-h", "--help"]) expect(parseArgs([flag])).toEqual({ run: "help" })
  for (const flag of ["-v", "--version"]) expect(parseArgs([flag])).toEqual({ run: "version" })
  expect(parseArgs(["update"])).toEqual({ run: "update" })
  for (const args of [["updte"], ["upgrade"], ["--foo"], ["-s"], ["-s", "update"], ["-s", "--help"], ["--session", "cafe"], ["update", "now"], ["-v", "extra"], [id, id], ["-s", id, "x"], [""]])
    expect(parseArgs(args)).toEqual({ run: "usage" })
})
