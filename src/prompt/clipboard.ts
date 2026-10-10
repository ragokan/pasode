import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import type { PromptSubmit } from "./types"

const exec = promisify(execFile)

// Adapted from OpenCode's clipboard.ts (MIT), without clipboardy or non-macOS dependencies.
export async function readClipboard(pastedText?: string, cwd = process.cwd()): Promise<{ image: PromptSubmit["images"][number] } | { text: string }> {
  // OpenCode's resolvePastedAttachments (MIT): quoted/escaped paths and file URLs.
  if (pastedText?.length) {
    const raw = pastedText.trim().replace(/^['"]+|['"]+$/g, "")
    let file = raw.replace(/\\(.)/g, "$1")
    if (raw.startsWith("file://")) {
      try {
        file = fileURLToPath(raw)
      } catch {
        return { text: pastedText }
      }
    }
    const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[path.extname(file).toLowerCase()]
    if (mimeType && !/^https?:\/\//.test(file)) {
      const source = Bun.file(path.resolve(cwd, file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file))
      if (await source.exists()) {
        const limit = 20 * 1024 * 1024
        if (source.size > limit) throw new Error("Attachment exceeds the 20 MB local file limit")
        const bytes = Buffer.from(await source.slice(0, limit + 1).arrayBuffer())
        if (bytes.length > limit) throw new Error("Attachment exceeds the 20 MB local file limit")
        return { image: { data: bytes.toString("base64"), mimeType } }
      }
    }
    return { text: pastedText }
  }
  if (process.platform !== "darwin") return { text: pastedText ?? "" }
  const directory = await mkdtemp(path.join(os.tmpdir(), "pasode-clipboard-"))
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
