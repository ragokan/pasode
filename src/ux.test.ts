import { expect, test } from "bun:test"
import { attentionNotice, selectionText, suspend, windowTitle } from "./ux"

const selection = (text: string, isStart: boolean, behavior: "cell" | "word" | "line") => ({ getSelectedText: () => text, isStart, behavior })

test("a bare click copies nothing; a drag, a double-click word or a triple-click line copies its text", () => {
  expect(selectionText(null)).toBe("")
  expect(selectionText(selection("", true, "cell"))).toBe("")
  expect(selectionText(selection("x", true, "cell"))).toBe("") // mouse down alone: the selection hasn't grown yet
  expect(selectionText(selection("dragged", false, "cell"))).toBe("dragged")
  expect(selectionText(selection("word", true, "word"))).toBe("word")
  expect(selectionText(selection("a whole line", true, "line"))).toBe("a whole line")
})

test("a notification names the session under a glyph for the reason, with the daemon's text as the body", () => {
  const body = "Fixed the parser."
  expect(attentionNotice({ reason: "finished", notification: { title: "Agent finished", body, data: {} } as never }, "Fix parser")).toEqual({ title: "✓ Fix parser", message: body })
  expect(attentionNotice({ reason: "error" }, null)).toEqual({ title: "✕ Untitled", message: "Needs your attention" })
  expect(attentionNotice({ reason: "permission", notification: { title: "", body: "Run rm -rf build?", data: {} } as never }, "Clean").title).toBe("△ Clean")
})

test("notification and title text can't carry escape sequences or run long", () => {
  const hostile = "a\x1b]0;owned\x07b\nc"
  const notice = attentionNotice({ reason: "finished", notification: { title: "", body: hostile, data: {} } as never }, hostile)
  expect(notice.title).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  expect(notice.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  expect(attentionNotice({ reason: "finished", notification: { title: "", body: "x".repeat(500), data: {} } as never }, "t".repeat(200))).toMatchObject({ title: expect.stringMatching(/^.{80}$/), message: expect.stringMatching(/^.{240}$/) })
  expect(windowTitle(hostile)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  expect(windowTitle("s".repeat(100))).toHaveLength(40)
})

test("the window title is the session's, or pasode without one", () => {
  expect(windowTitle("Fix parser")).toBe("Fix parser")
  expect(windowTitle(undefined)).toBe("pasode")
  expect(windowTitle(null)).toBe("pasode")
})

test("suspend hands the terminal back before stopping, and resumes when the shell continues it", () => {
  const calls: string[] = []
  suspend(
    { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") },
    () => calls.push("retitle"),
    (pid, signal) => calls.push(`kill ${pid} ${signal}`),
  )
  expect(calls).toEqual(["suspend", "kill 0 SIGTSTP"])
  process.emit("SIGCONT")
  expect(calls).toEqual(["suspend", "kill 0 SIGTSTP", "resume", "retitle"])
  process.emit("SIGCONT") // once only: a later SIGCONT (e.g. a second fg) mustn't resume a renderer that isn't suspended
  expect(calls).toHaveLength(4)
})
