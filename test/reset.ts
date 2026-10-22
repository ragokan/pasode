// Tests share one process, so the app's module-level stores outlive each test. Every test starts from this blank state;
// without it a test passes or fails depending on which files ran before it (`bun test --randomize` finds the difference).
import { reconcile } from "solid-js/store"
import { resetComposer } from "../src/composer"
import { dialog } from "../src/dialog"
import { openTimeline, setAgents, setCatalog, setWorkspacePins, setWorkspaceTitles } from "../src/paseo"
import { prefs, setAgentId, setDraft, setPrefsStore, setSubagent, setToast } from "../src/state"
import { resetTerminals } from "../src/terminal"

const initialPrefs = { ...prefs }

export function resetStores() {
  // A root a failed test never disposed may throw while its inputs are cleared; that must not fail the next test too.
  const quietly = (step: () => void) => {
    try {
      step()
    } catch {}
  }
  quietly(() => setAgentId(undefined))
  quietly(() => setSubagent(undefined))
  quietly(() => setAgents(reconcile({})))
  quietly(() => setWorkspaceTitles(reconcile({})))
  quietly(() => setWorkspacePins(reconcile({})))
  quietly(() => setCatalog(reconcile({})))
  quietly(() => void openTimeline(undefined))
  quietly(() => setPrefsStore(initialPrefs))
  quietly(() => setDraft({ provider: "claude" }))
  quietly(() => setToast(undefined))
  quietly(() => dialog.clear())
  quietly(resetComposer)
  quietly(resetTerminals)
}
