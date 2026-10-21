import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { localDaemon, refused } from "./local-daemon"

const homes = mkdtempSync(path.join(os.tmpdir(), "pasode-homes-"))
afterAll(() => rmSync(homes, { recursive: true, force: true }))

const home = (listen?: string) => {
  const dir = mkdtempSync(path.join(homes, "home-"))
  if (listen) writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, daemon: { listen } }))
  return dir
}

test("a local TCP listen address in PASEO_HOME is a daemon pasode may start", () => {
  for (const [listen, host, port] of [
    ["127.0.0.1:6799", "127.0.0.1", 6799],
    ["0.0.0.0:6767", "0.0.0.0", 6767],
    ["localhost:7000", "localhost", 7000],
  ] as const) {
    const dir = home(listen)
    expect(localDaemon({ PASEO_HOME: dir })).toEqual({ home: dir, host, port })
  }
  const bare = home()
  expect(localDaemon({ PASEO_HOME: bare })).toEqual({ home: bare, host: "127.0.0.1", port: 6767 })
})

test("never a daemon to start with PASEO_URL, a remote address or a socket", () => {
  expect(localDaemon({ PASEO_URL: "ws://127.0.0.1:6767/ws", PASEO_HOME: home("127.0.0.1:6767") })).toBeUndefined()
  expect(localDaemon({ PASEO_HOME: home("10.0.0.5:6767") })).toBeUndefined()
  expect(localDaemon({ PASEO_HOME: home("devbox.example:6767") })).toBeUndefined()
  expect(localDaemon({ PASEO_HOME: home("/tmp/paseo.sock") })).toBeUndefined()
})

test("refused only when nothing listens; a server that answers and hangs up is not", async () => {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: (socket) => void socket.end(), data() {} } })
  expect(await refused("127.0.0.1", server.port)).toBe(false)
  server.stop(true)
  expect(await refused("127.0.0.1", server.port)).toBe(true)
})
