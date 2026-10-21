import { chmodSync, renameSync } from "node:fs"
import pkg from "../package.json"
import { notify } from "./state"

const RELEASES = "https://api.github.com/repos/ragokan/pasode/releases/latest"
/** Release binaries run from Bun's embedded filesystem; a source checkout runs under `bun`. */
export const compiled = Bun.main.startsWith("/$bunfs/")
const asset = `pasode-${process.platform}-${process.arch}.gz`

export type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] }

/** The latest GitHub release, if it is newer than this build. */
export async function newerRelease(): Promise<Release | undefined> {
  const response = await fetch(RELEASES, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Checking for updates failed: GitHub answered ${response.status}`)
  const release = (await response.json()) as Release
  return Bun.semver.order(release.tag_name.replace(/^v/, ""), pkg.version) === 1 ? release : undefined
}

async function download(release: Release, name: string) {
  const url = release.assets.find((item) => item.name === name)?.browser_download_url
  if (!url) throw new Error(`pasode ${release.tag_name} has no ${name}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${name} failed: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Set once a new binary is in place; index.tsx then relaunches instead of exiting. */
export let installed = false

/** Replaces `target` with this machine's binary from `release`, only if it matches the release's SHA256SUMS. */
export async function install(release: Release, target = process.execPath) {
  const [archive, sums] = await Promise.all([download(release, asset), download(release, "SHA256SUMS")])
  const expected = new TextDecoder().decode(sums).split("\n").find((line) => line.endsWith(`  ${asset}`))?.slice(0, 64)
  if (expected !== new Bun.CryptoHasher("sha256").update(archive).digest("hex")) throw new Error(`${asset} doesn't match the release checksums`)
  // A rename, not an overwrite: the running process keeps its file, and macOS never sees a signed binary change in place.
  await Bun.write(`${target}.update`, Bun.gunzipSync(archive))
  chmodSync(`${target}.update`, 0o755)
  renameSync(`${target}.update`, target)
  installed = true
}

/** /update: installs a newer release, then `quit` closes the TUI and `relaunch` starts the new binary. */
export async function update(quit: () => void) {
  notify("Checking for updates…")
  const release = await newerRelease()
  if (!release) return notify(`pasode ${pkg.version} is up to date`, "success")
  if (!compiled) return notify(`pasode ${release.tag_name} is out. This is a source checkout: update it with git pull.`, "warning")
  notify(`Downloading pasode ${release.tag_name}…`)
  await install(release)
  quit()
}

/** On open: mention a newer release, quietly (offline or rate-limited checks just skip). */
export const checkForUpdate = () =>
  newerRelease()
    .then((release) => release && notify(`pasode ${release.tag_name} is available: ${compiled ? "run /update" : "git pull"}`, "info", "Update"))
    .catch(() => {})

/** Runs the new binary in this terminal, back in the same session, and exits with it. */
export async function relaunch(id: string | undefined) {
  const child = Bun.spawn([process.execPath, ...(id ? ["-s", id] : [])], { stdio: ["inherit", "inherit", "inherit"] })
  process.exit(await child.exited)
}
