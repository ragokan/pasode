import type { CliRenderer } from "@opentui/core"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Adapted from OpenCode's editor.ts (MIT); always resume, including spawn failures.
export async function editPrompt(text: string, cwd: string, renderer: CliRenderer): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pasode-editor-"))
  const file = path.join(directory, "prompt.md")
  let suspended = false
  let completed = false
  try {
    await writeFile(file, text, { mode: 0o600 })
    renderer.suspend()
    suspended = true
    renderer.currentRenderBuffer.clear()
    await new Promise<void>((resolve, reject) => {
      // The shell handles quoted editor paths/flags; the temp path is passed as $1, not interpolated.
      const child = spawn(process.env.SHELL || "/bin/sh", ["-c", `${process.env.VISUAL || process.env.EDITOR || "vi"} "$1"`, "pasode-editor", file], { cwd, stdio: "inherit" })
      child.on("error", (error) => reject(new Error(`${error.message}; draft saved at ${file}`, { cause: error })))
      child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor exited with ${signal || code}; draft saved at ${file}`)))
    })
    const value = await readFile(file, "utf8")
    completed = true
    return value
  } finally {
    if (suspended) {
      renderer.currentRenderBuffer.clear()
      renderer.resume()
      renderer.requestRender()
    }
    // Preserve the edited file on failure so a crashed editor cannot lose the draft.
    if (completed) await rm(directory, { recursive: true, force: true })
  }
}
