import { existsSync, readFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Paseo.app's bundled CLI matches the app's daemon; a global npm `paseo` on PATH can be older than the state it would run on.
const APP_CLI = "/Applications/Paseo.app/Contents/Resources/bin/paseo"

/** The daemon pasode may start itself: none with PASEO_URL, else PASEO_HOME's listen address if it is TCP on this machine. */
export function localDaemon(env: Record<string, string | undefined> = process.env) {
  if (env.PASEO_URL) return
  const home = env.PASEO_HOME ?? path.join(os.homedir(), ".paseo")
  let listen: unknown = "127.0.0.1:6767"
  try {
    listen = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8")).daemon?.listen ?? listen
  } catch {}
  const match = typeof listen === "string" ? /^(localhost|127(?:\.\d+){3}|0\.0\.0\.0):(\d+)$/.exec(listen) : null
  return match ? { home, host: match[1]!, port: Number(match[2]) } : undefined
}

/** True only when nothing listens on the port. A daemon that answers, even to reject us, is left alone. */
export function refused(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, host)
    socket.once("connect", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"))
  })
}

/** Starts the local daemon when nothing listens; `paseo daemon start` detaches it and returns once it accepts connections. */
export async function startLocalDaemon() {
  const target = localDaemon()
  if (!target || !(await refused(target.host, target.port))) return
  console.error("Starting local Paseo daemon…")
  const cli = process.platform === "darwin" && existsSync(APP_CLI) ? APP_CLI : "paseo"
  try {
    const start = Bun.spawn([cli, "daemon", "start", "--home", target.home, "--timeout", "60"], { stdout: "ignore", stderr: "pipe" })
    const code = await start.exited
    if (code !== 0) throw new Error((await new Response(start.stderr).text()).trim() || `exit code ${code}`)
  } catch (error) {
    throw new Error(`\`${cli} daemon start\` failed: ${error instanceof Error ? error.message : error}`)
  }
}
