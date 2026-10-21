import { expect, spyOn, test } from "bun:test"
import { copyToClipboard, hostClipboardCommands, useClipboardRenderer, writeHostClipboard } from "./copy"

const child = (code: number, written: string[] = []) => ({ stdin: { write: (text: string) => written.push(text), end: () => {} }, exited: Promise.resolve(code) })

test("host clipboard writers: pbcopy on macOS, Wayland then X11 on Linux, none elsewhere", () => {
  expect(hostClipboardCommands("darwin")).toEqual([["pbcopy"]])
  expect(hostClipboardCommands("linux").map(([binary]) => binary)).toEqual(["wl-copy", "xclip", "xsel"])
  expect(hostClipboardCommands("win32")).toEqual([])
})

test("a missing binary or a failing writer falls through to the next; the first success stops the search", async () => {
  const tried: string[] = []
  const written: string[] = []
  const start = (command: string[]) => {
    tried.push(command[0]!)
    if (command[0] === "wl-copy") throw new Error("ENOENT") // not installed
    if (command[0] === "xclip") return child(1) // no X display
    return child(0, written)
  }
  expect(await writeHostClipboard("hello", hostClipboardCommands("linux"), start)).toBe(true)
  expect(tried).toEqual(["wl-copy", "xclip", "xsel"])
  expect(written).toEqual(["hello"])

  tried.length = 0
  expect(await writeHostClipboard("x", [["wl-copy"], ["xclip"]], (command) => (tried.push(command[0]!), child(0)))).toBe(true)
  expect(tried).toEqual(["wl-copy"])
})

test("no writer available means no host copy", async () => {
  expect(await writeHostClipboard("x", hostClipboardCommands("linux"), () => { throw new Error("ENOENT") })).toBe(false)
  expect(await writeHostClipboard("x", [], () => child(0))).toBe(false)
})

test("copyToClipboard sends OSC 52 through the renderer and counts it as copied when no host clipboard exists", async () => {
  const sent: string[] = []
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => { throw new Error("ENOENT") }) as never)
  try {
    useClipboardRenderer({ copyToClipboardOSC52: (text) => (sent.push(text), true) })
    expect(await copyToClipboard("via osc52")).toBe(true)
    expect(sent).toEqual(["via osc52"])
    useClipboardRenderer({ copyToClipboardOSC52: () => false }) // a terminal known not to support it
    expect(await copyToClipboard("nowhere")).toBe(false)
  } finally {
    spawn.mockRestore()
    useClipboardRenderer(undefined)
  }
})
