import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const script = path.join(import.meta.dir, "..", "install.sh")
const asset = `pasode-${process.platform}-${process.arch}.gz`
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const binary = (version: string) => new TextEncoder().encode(`fake pasode ${version}`)

const root = mkdtempSync(path.join(os.tmpdir(), "pasode-install-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A fake GitHub releases page: latest redirects to v9.9.9; `tampered` releases ship a wrong checksum. */
let tampered = new Set<string>()
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/releases/latest") return Response.redirect(`${url.origin}/releases/tag/v9.9.9`, 302)
      if (url.pathname.startsWith("/releases/tag/")) return new Response("release page")
      const [, tag, name] = /^\/releases\/download\/v([^/]+)\/(.+)$/.exec(url.pathname) ?? []
      if (!tag) return new Response("not found", { status: 404 })
      const archive = Bun.gzipSync(binary(tag))
      if (name === asset) return new Response(archive)
      if (name === "SHA256SUMS") return new Response(`${"0".repeat(64)}  pasode-other-os.gz\n${tampered.has(tag) ? "f".repeat(64) : sha256(archive)}  ${asset}\n`)
      return new Response("not found", { status: 404 })
    },
  })
})
afterAll(() => server.stop(true))

// macOS runs `curl … | sh` with bash in POSIX mode; Debian and Ubuntu with dash.
const shells = [["sh"], ...(Bun.which("bash") ? [["bash", "--posix"]] : [])]

async function install(dir: string, env: Record<string, string> = {}, shell = ["sh"]) {
  const child = Bun.spawn([...shell, script], {
    env: { PATH: process.env.PATH!, HOME: root, PASODE_RELEASES: `http://127.0.0.1:${server.port}/releases`, PASODE_INSTALL_DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

test.each(shells)("%s: installs the latest release into the directory, warns when it isn't on PATH, and a rerun renames over it", async (...shell) => {
  const dir = path.join(root, shell.join("-"), "bin")
  const first = await install(dir, {}, shell)
  expect(first).toMatchObject({ code: 0, stdout: `pasode 9.9.9 installed to ${dir}/pasode\n` })
  expect(first.stderr).toContain(`${dir} is not on your PATH`)
  expect(readFileSync(path.join(dir, "pasode"), "utf8")).toBe("fake pasode 9.9.9")
  expect(statSync(path.join(dir, "pasode")).mode & 0o777).toBe(0o755)

  // A rerun replaces the file by rename (new inode), so a running pasode keeps the one it started from.
  const before = statSync(path.join(dir, "pasode")).ino
  const again = await install(dir, { PATH: `${dir}:${process.env.PATH}` }, shell)
  expect(again).toEqual({ code: 0, stdout: `pasode 9.9.9 installed to ${dir}/pasode\n`, stderr: "" })
  expect(statSync(path.join(dir, "pasode")).ino).not.toBe(before)
  expect(readdirSync(dir)).toEqual(["pasode"])
})

test("PASODE_VERSION pins a release, with or without the v", async () => {
  const dir = path.join(root, "pinned")
  for (const version of ["1.2.3", "v1.2.3"]) {
    const result = await install(dir, { PASODE_VERSION: version })
    expect(result).toMatchObject({ code: 0, stdout: `pasode 1.2.3 installed to ${dir}/pasode\n` })
    expect(readFileSync(path.join(dir, "pasode"), "utf8")).toBe("fake pasode 1.2.3")
  }
})

test("a checksum mismatch or a missing release fails and leaves the installed pasode alone", async () => {
  const dir = path.join(root, "failing")
  await install(dir, { PASODE_VERSION: "1.0.0" })
  tampered = new Set(["2.0.0"])
  const bad = await install(dir, { PASODE_VERSION: "2.0.0" })
  expect(bad.code).toBe(1)
  expect(bad.stderr).toContain(`${asset} doesn't match the SHA256SUMS of v2.0.0`)
  const offline = await install(dir, { PASODE_RELEASES: "http://127.0.0.1:1/releases" })
  expect(offline.code).toBe(1)
  expect(offline.stderr).toContain("couldn't reach")
  expect(readFileSync(path.join(dir, "pasode"), "utf8")).toBe("fake pasode 1.0.0")
  expect(readdirSync(dir)).toEqual(["pasode"])
})
