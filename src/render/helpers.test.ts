import { describe, expect, test } from "bun:test"
import { applyPatch, parsePatch } from "diff"
import { collapseToolOutput, editDiff, filetype, reasoningSummary, senderLabel, timestampLabel } from "./helpers"

describe("editDiff", () => {
  test("keeps an existing unified diff", () => {
    expect(editDiff({ type: "edit", filePath: "a.ts", unifiedDiff: "existing patch", oldString: "a", newString: "b" })).toBe("existing patch")
  })
  test.each([
    ["old\nshared\n", "new\nshared\n"],
    ["", "new\n"],
    ["old\n", ""],
    ["old", "new"],
    ["same", "same\n"],
    ["a\r\nb\r\n", "a\r\nc\r\n"],
  ])("builds a parseable, applicable patch: %j → %j", (oldString, newString) => {
    const diff = editDiff({ type: "edit", filePath: "file with spaces.ts", oldString, newString })
    expect(parsePatch(diff)[0]?.hunks.length).toBeGreaterThan(0)
    expect(applyPatch(oldString, diff)).toBe(newString)
  })
  test("does not invent missing content or show an unchanged edit", () => {
    expect(editDiff({ type: "edit", filePath: "a" })).toBe("")
    expect(editDiff({ type: "edit", filePath: "a", oldString: "old" })).toBe("")
    expect(editDiff({ type: "edit", filePath: "a", oldString: "same", newString: "same" })).toBe("")
  })
})

test.each([
  ["/src/app.tsx", "typescript"], ["/src/app.JSX", "typescript"], ["app.mjs", "typescript"],
  ["script.py", "python"], ["config.yml", "yaml"], ["notes.md", "markdown"],
  ["Dockerfile", "dockerfile"], ["Dockerfile.dev", "dockerfile"], ["Makefile", "makefile"],
  ["README", "none"], ["data.unknown", "none"],
])("filetype(%s) = %s", (filename, expected) => expect(filetype(filename)).toBe(expected))

describe("collapseToolOutput", () => {
  test("preserves short output and empty output", () => {
    expect(collapseToolOutput("a\nb")).toEqual({ output: "a\nb", overflow: false })
    expect(collapseToolOutput("")).toEqual({ output: "", overflow: false })
  })
  test("limits the preview to ten lines", () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
    const collapsed = collapseToolOutput(output)
    expect(collapsed.overflow).toBe(true)
    expect(collapsed.output).toContain("line 10\n…")
    expect(collapsed.output).not.toContain("line 11")
  })
  test("limits long lines without splitting surrogate pairs", () => {
    expect(collapseToolOutput("😀😀😀😀", 10, 3)).toEqual({ output: "😀😀…", overflow: true })
  })
})

test("reasoning summaries prefer a bold title, otherwise the first line", () => {
  expect(reasoningSummary(" **Inspecting code**\n\nDetails")).toBe("Inspecting code")
  expect(reasoningSummary("# Inspecting code\nDetails")).toBe("Inspecting code")
  expect(reasoningSummary("First line\nSecond line")).toBe("First line")
  expect(reasoningSummary("")).toBe("")
})

test("timestamps show time today, date and time otherwise; invalid timestamps are empty", () => {
  const today = new Date(2026, 9, 9, 14, 30)
  const yesterday = new Date(2026, 9, 8, 14, 30)
  const time = today.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  expect(timestampLabel(today.getTime(), today)).toBe(time)
  expect(timestampLabel(yesterday.getTime(), today)).toBe(`${yesterday.toLocaleDateString()} ${time}`)
  expect(timestampLabel(NaN, today)).toBe("")
})

test("an agent message's sender is its title, else its id with a UUID shortened", () => {
  expect(senderLabel({ id: "3f2a9c1e-0b7d-4e55-9a31-5d0c7e8b1a42", title: " Reviewer " })).toBe("Reviewer")
  expect(senderLabel({ id: "3f2a9c1e-0b7d-4e55-9a31-5d0c7e8b1a42" })).toBe("3f2a9c1e")
  expect(senderLabel({ id: "remote::worker", title: "" })).toBe("remote::worker")
})
