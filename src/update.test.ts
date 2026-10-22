import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import pkg from "../package.json"
import { install, newerRelease, updateCommand, type Release } from "./update"

const dir = mkdtempSync(path.join(os.tmpdir(), "pasode-update-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const asset = `pasode-${process.platform}-${process.arch}.gz`
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
let fetchMock: ReturnType<typeof spyOn> | undefined
afterEach(() => fetchMock?.mockRestore())

/** A fake GitHub: the latest-release JSON and its assets by URL. */
function github(files: Record<string, string | Uint8Array>) {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (url: string) =>
    url in files ? new Response(files[url] as BodyInit) : new Response("not found", { status: 404 })) as unknown as typeof fetch)
}
const release = (tag: string): Release => ({
  tag_name: tag,
  assets: [asset, "SHA256SUMS"].map((name) => ({ name, browser_download_url: `https://dl/${name}` })),
})

test("only a higher release version counts as an update", async () => {
  const [major, minor, patch] = pkg.version.split(".").map(Number) as [number, number, number]
  for (const [tag, newer] of [[`v${major}.${minor}.${patch + 1}`, true], [`v${major}.${minor + 1}.0`, true], [`v${pkg.version}`, false], ["v0.0.1", false]] as const) {
    github({ "https://api.github.com/repos/ragokan/pasode/releases/latest": JSON.stringify(release(tag)) })
    expect((await newerRelease())?.tag_name).toBe(newer ? tag : undefined)
    fetchMock?.mockRestore()
  }
})

test("install swaps in the binary only when it matches the release checksums", async () => {
  const target = path.join(dir, "pasode")
  writeFileSync(target, "old binary")
  const archive = Bun.gzipSync(new TextEncoder().encode("new binary"))

  github({ [`https://dl/${asset}`]: archive, "https://dl/SHA256SUMS": `${sha256(new TextEncoder().encode("tampered"))}  ${asset}\n` })
  await expect(install(release("v9.0.0"), target)).rejects.toThrow("doesn't match the release checksums")
  expect(readFileSync(target, "utf8")).toBe("old binary")
  fetchMock?.mockRestore()

  github({ [`https://dl/${asset}`]: archive, "https://dl/SHA256SUMS": `${"0".repeat(64)}  pasode-other-os.gz\n${sha256(archive)}  ${asset}\n` })
  await install(release("v9.0.0"), target)
  expect(readFileSync(target, "utf8")).toBe("new binary")
  expect(statSync(target).mode & 0o777).toBe(0o755)
  expect(existsSync(`${target}.update`)).toBe(false)
})

const latest = "https://api.github.com/repos/ragokan/pasode/releases/latest"

test("pasode update installs a newer release over the binary and reports old -> new", async () => {
  const target = path.join(dir, "pasode-cli")
  writeFileSync(target, "old binary")
  const archive = Bun.gzipSync(new TextEncoder().encode("new binary"))
  github({ [latest]: JSON.stringify(release("v99.0.0")), [`https://dl/${asset}`]: archive, "https://dl/SHA256SUMS": `${sha256(archive)}  ${asset}\n` })
  expect(await updateCommand(target, true)).toBe(`pasode ${pkg.version} -> 99.0.0`)
  expect(readFileSync(target, "utf8")).toBe("new binary")
})

test("pasode update leaves a current binary alone", async () => {
  const target = path.join(dir, "pasode-current")
  writeFileSync(target, "old binary")
  github({ [latest]: JSON.stringify(release(`v${pkg.version}`)) })
  expect(await updateCommand(target, true)).toBe(`pasode ${pkg.version} is up to date`)
  expect(readFileSync(target, "utf8")).toBe("old binary")
})

test("pasode update fails, keeping the binary, when GitHub can't be reached or the checksum is wrong", async () => {
  const target = path.join(dir, "pasode-failing")
  writeFileSync(target, "old binary")
  fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unable to connect"))
  await expect(updateCommand(target, true)).rejects.toThrow("Unable to connect")
  fetchMock.mockRestore()
  github({}) // GitHub answers, but not with a release
  await expect(updateCommand(target, true)).rejects.toThrow("GitHub answered 404")
  fetchMock?.mockRestore()
  const archive = Bun.gzipSync(new TextEncoder().encode("new binary"))
  github({ [latest]: JSON.stringify(release("v99.0.0")), [`https://dl/${asset}`]: archive, "https://dl/SHA256SUMS": `${"0".repeat(64)}  ${asset}\n` })
  await expect(updateCommand(target, true)).rejects.toThrow("doesn't match the release checksums")
  expect(readFileSync(target, "utf8")).toBe("old binary")
})

test("pasode update refuses a source checkout before asking GitHub", async () => {
  fetchMock = spyOn(globalThis, "fetch")
  await expect(updateCommand(path.join(dir, "unused"), false)).rejects.toThrow("source checkout")
  expect(fetchMock).not.toHaveBeenCalled()
})
