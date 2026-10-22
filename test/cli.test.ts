import { expect, test } from "bun:test"
import path from "node:path"
import pkg from "../package.json"

const bin = path.join(import.meta.dir, "..", "bin", "paseo-tui.ts")

test.each(["--version", "-v"])("%s prints the version and exits without opening the TUI or touching the daemon", async (flag) => {
  // A stand-in daemon that counts connection attempts; the flag must never reach it.
  let attempts = 0
  const server = Bun.serve({ port: 0, fetch: () => (attempts++, new Response("no")) })
  try {
    const child = Bun.spawn([process.execPath, bin, flag], {
      env: { ...process.env, PASEO_URL: `ws://127.0.0.1:${server.port}/ws` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect({ stdout, code, attempts }).toEqual({ stdout: `${pkg.version}\n`, code: 0, attempts: 0 })
  } finally {
    server.stop(true)
  }
})
