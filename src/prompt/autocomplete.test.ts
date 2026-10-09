import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listFiles, mentionQuery, promptOffsetWidth, rankFiles } from "./autocomplete"

test("mention query requires a word boundary and supports cursor-local mentions", () => {
  expect(mentionQuery("@src/ap")).toEqual({ query: "src/ap", start: 0, end: 7 })
  expect(mentionQuery("read\n@src/ap rest", 12)).toEqual({ query: "src/ap", start: 5, end: 12 })
  expect(mentionQuery("read @")).toEqual({ query: "", start: 5, end: 6 })
  expect(mentionQuery("me@example.com")).toBeUndefined()
  expect(mentionQuery("read @src/app.ts ")).toBeUndefined()
  expect(mentionQuery("@@foo")).toBeUndefined()
})

test("file ranking prefers exact basenames, basename prefixes, then path prefixes", () => {
  const files = ["src/a/p/p.ts", "app/deep.ts", "src/apple.ts", "src/app", "unrelated.ts"]
  expect(rankFiles(files, "app")).toEqual(["src/app", "src/apple.ts", "app/deep.ts", "src/a/p/p.ts"])
  expect(rankFiles(files, "SAP", 2)).toHaveLength(2)
  expect(rankFiles(files, "missing")).toEqual([])
  expect(rankFiles(files, "", 2)).toHaveLength(2)
})

test("display offsets count graphemes and newlines like the textarea", () => {
  expect(promptOffsetWidth("a\n好e\u0301")).toBe(5)
  expect(promptOffsetWidth("👩‍💻\n@")).toBe(4)
})

test("file scan falls back outside git and excludes node_modules and .git", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-files-test-"))
  try {
    await mkdir(path.join(directory, "src"))
    await mkdir(path.join(directory, "node_modules"))
    await mkdir(path.join(directory, ".git"))
    await writeFile(path.join(directory, "src", "app.ts"), "")
    await writeFile(path.join(directory, ".env"), "")
    await writeFile(path.join(directory, "node_modules", "ignored.ts"), "")
    await writeFile(path.join(directory, ".git", "ignored"), "")
    expect(await listFiles(directory)).toEqual([".env", "src/app.ts"])
    expect(listFiles(directory)).toBe(listFiles(directory))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("git file scan includes untracked files but respects gitignore", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-git-files-test-"))
  try {
    const git = Bun.spawn(["git", "init", "-q", directory], { stdout: "ignore", stderr: "ignore" })
    expect(await git.exited).toBe(0)
    await writeFile(path.join(directory, ".gitignore"), "ignored.txt\n")
    await writeFile(path.join(directory, "visible.ts"), "")
    await writeFile(path.join(directory, "ignored.txt"), "")
    expect((await listFiles(directory)).toSorted()).toEqual([".gitignore", "visible.ts"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
