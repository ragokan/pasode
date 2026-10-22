// Tests never touch the user's ~/.config/pasode/cli.json or ~/.local/state/pasode/kv.json.
import { afterAll, afterEach, beforeEach, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(os.tmpdir(), "pasode-test-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
process.env.PASODE_CONFIG_DIR = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")

// Imported only now: the app modules read these directories when they load.
const { resetStores } = await import("./reset")
beforeEach(resetStores)
afterEach(() => mock.restore())
