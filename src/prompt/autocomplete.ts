import { lstat } from "node:fs/promises"
import path from "node:path"

export type MentionQuery = { query: string; start: number; end: number }

export function mentionQuery(text: string, cursor = text.length): MentionQuery | undefined {
  const before = text.slice(0, cursor)
  const match = before.match(/(?:^|\s)@([^\s@]*)$/)
  if (!match) return
  return { query: match[1]!, start: before.lastIndexOf("@"), end: cursor }
}

export function rankFiles(files: string[], query: string, limit = 8): string[] {
  const needle = query.toLowerCase()
  return files.flatMap((file) => {
    const value = file.toLowerCase()
    let at = 0
    let score = 0
    for (const char of needle) {
      const next = value.indexOf(char, at)
      if (next < 0) return []
      score += next - at
      at = next + 1
    }
    const name = path.posix.basename(value)
    if (name === needle) score -= 1000
    else if (name.startsWith(needle)) score -= 500
    else if (value.startsWith(needle)) score -= 250
    return [{ file, score }]
  }).sort((a, b) => a.score - b.score || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .slice(0, limit).map((item) => item.file)
}

// OpenTUI cursor offsets use display columns, with one position per newline.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
export function promptOffsetWidth(value: string) {
  let width = 0
  for (const part of graphemes.segment(value)) width += part.segment === "\n" ? 1 : Bun.stringWidth(part.segment)
  return width
}

const cache = new Map<string, { until: number; files: Promise<string[]> }>()
const MAX_FILES = 20_000
const ignored = (file: string) => file.split("/").some((part) => part === "node_modules" || part === ".git")

export function listFiles(cwd: string): Promise<string[]> {
  const directory = path.resolve(cwd)
  const cached = cache.get(directory)
  if (cached && cached.until > Date.now()) return cached.files
  const files = scanFiles(directory).catch((error) => {
    cache.delete(directory)
    throw error
  })
  cache.set(directory, { until: Date.now() + 30_000, files })
  return files
}

async function scanFiles(cwd: string): Promise<string[]> {
  try {
    const git = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, stdout: "pipe", stderr: "ignore" })
    const output = await new Response(git.stdout).text()
    if (await git.exited === 0) return [...new Set(output.split("\0").filter((file) => file && !ignored(file)))].slice(0, MAX_FILES)
  } catch {
    // A missing git executable or non-repository directory uses the local scan.
  }
  const files: string[] = []
  const directories = [""]
  const glob = new Bun.Glob("*")
  while (directories.length && files.length < MAX_FILES) {
    const directory = directories.pop()!
    for await (const name of glob.scan({ cwd: path.join(cwd, directory), dot: true, onlyFiles: false, followSymlinks: false })) {
      const relative = directory ? `${directory}/${name}` : name
      if (ignored(relative)) continue
      const stat = await lstat(path.join(cwd, relative)).catch(() => undefined)
      if (stat?.isDirectory()) directories.push(relative)
      if (stat?.isFile()) files.push(relative)
      if (files.length >= MAX_FILES) break
    }
  }
  return files.sort()
}
