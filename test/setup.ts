// Tests never touch the user's ~/.config/pasode/cli.json or ~/.local/state/pasode/kv.json.
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(os.tmpdir(), "pasode-test-"))
process.env.PASODE_CONFIG_DIR = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
