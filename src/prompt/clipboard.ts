import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { PromptSubmit } from "./types"

const exec = promisify(execFile)

// Adapted from OpenCode's clipboard.ts (MIT), without clipboardy or non-macOS dependencies.
export async function readClipboard(pastedText?: string): Promise<{ image: PromptSubmit["images"][number] } | { text: string }> {
  if (process.platform !== "darwin") return { text: pastedText ?? "" }
  const directory = await mkdtemp(path.join(os.tmpdir(), "pascode-clipboard-"))
  const file = path.join(directory, "image.png")
  try {
    await exec("osascript", [
      "-e", 'set imageData to the clipboard as "PNGf"',
      "-e", `set fileRef to open for access POSIX file ${JSON.stringify(file)} with write permission`,
      "-e", "set eof fileRef to 0",
      "-e", "write imageData to fileRef",
      "-e", "close access fileRef",
    ], { timeout: 5000 })
    const bytes = await readFile(file)
    if (bytes.length) return { image: { data: bytes.toString("base64"), mimeType: "image/png" } }
  } catch {
    // macOS rejects PNGf when the clipboard contains ordinary text.
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  if (pastedText !== undefined) return { text: pastedText }
  return { text: (await exec("pbpaste", [], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })).stdout }
}
