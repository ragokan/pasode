// Tests never touch the user's ~/.config/pascode/cli.json or ~/.local/state/pascode/kv.json.
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(os.tmpdir(), "pasode-test-"))
process.env.PASCODE_CONFIG_DIR = path.join(root, "config")
process.env.XDG_STATE_HOME = path.join(root, "state")
