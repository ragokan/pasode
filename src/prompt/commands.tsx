import { createSignal } from "solid-js"
import { rememberImages } from "../attachments"
import { registerCommands } from "../commands"
import { dialog, DialogSelect, truncate } from "../dialog"
import { api } from "../paseo"
import { agentId, notify, showError } from "../state"
import { theme } from "../theme"
import { appendSnapshot } from "./paste"
import { dequeue, queueOf, sendQueued } from "./queue"
import { popStash, pushStash, removeStash, stashList, stashSnapshot, type StashEntry } from "./stash"
import type { PromptRef, PromptSnapshot, PromptSubmit } from "./types"

const age = (timestamp: number) => {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
}
const lineCount = (text: string) => text.split("\n").length

/** Prompt commands: stash (OpenCode's prompt.stash*), queued prompts (prompt.queue). Call once from App. */
export function registerPromptCommands(getPrompt: () => PromptRef | undefined) {
  // Onto what's already typed, so restoring never discards a draft.
  const restore = (snapshot: PromptSnapshot) => {
    const prompt = getPrompt()
    prompt?.restore(appendSnapshot(prompt.snapshot(), snapshot))
  }

  function stash() {
    const prompt = getPrompt()
    const snapshot = prompt?.snapshot()
    if (!prompt || !snapshot || (!snapshot.text.trim() && !snapshot.images.length)) return notify("Nothing to stash", "warning")
    pushStash(snapshot)
    prompt.clear()
    notify(`Stashed (${stashList().length}); /unstash brings it back`)
  }

  function openStash() {
    const [confirm, setConfirm] = createSignal<number>()
    // Newest first; the option value stays the stash index.
    const options = () =>
      stashList()
        .map((entry, index) => ({
          title: confirm() === index ? "Press ctrl+d again to delete" : truncate(entry.text.split("\n")[0]!, 50),
          bg: confirm() === index ? theme.error : undefined,
          value: index,
          description: age(entry.timestamp),
          footer: lineCount(entry.text) > 1 ? `~${lineCount(entry.text)} lines` : undefined,
        }))
        .reverse()
    dialog.replace(() => (
      <DialogSelect
        title="Stash"
        emptyText="Nothing stashed"
        options={options()}
        onMove={() => setConfirm(undefined)}
        onSelect={(option) => {
          const entry: StashEntry | undefined = stashList()[option.value]
          dialog.clear()
          if (!entry) return
          removeStash(option.value)
          restore(stashSnapshot(entry))
        }}
        actions={[
          {
            label: "ctrl+d",
            title: "delete",
            match: (key) => key.ctrl && key.name === "d",
            run: (option) => {
              if (confirm() !== option.value) return setConfirm(option.value)
              setConfirm(undefined)
              removeStash(option.value)
            },
          },
        ]}
      />
    ))
  }

  function openQueue() {
    const id = agentId()
    if (!id) return
    const options = () =>
      queueOf(id).map((item, index, list) => ({
        title: truncate(item.text, 60) || "(images)",
        value: index,
        description: item.images.length ? `${item.images.length} image${item.images.length > 1 ? "s" : ""}` : undefined,
        footer: `${index + 1} of ${list.length}`,
      }))
    dialog.replace(() => (
      <DialogSelect
        title="Queued prompts"
        emptyText="Nothing queued"
        options={options()}
        search={false}
        onSelect={(option) => {
          const item = queueOf(id)[option.value]
          dialog.clear()
          if (!item) return
          dequeue(id, option.value)
          restore({ ...item, pasted: [] })
        }}
        actions={[{ label: "ctrl+d", title: "delete", match: (key) => key.ctrl && key.name === "d", run: (option) => dequeue(id, option.value) }]}
      />
    ))
  }

  registerCommands([
    { id: "prompt.stash", title: "Stash prompt", category: "Prompt", slash: "stash", run: stash },
    { id: "prompt.stash.pop", title: "Pop stash", category: "Prompt", slash: "unstash", enabled: () => stashList().length > 0, run: () => { const entry = popStash(); if (entry) restore(stashSnapshot(entry)) } },
    { id: "prompt.stash.list", title: "Stash list", category: "Prompt", slash: "stashes", enabled: () => stashList().length > 0, run: openStash },
    // While a turn runs this holds the message until it ends; otherwise it's an ordinary send.
    { id: "prompt.queue", title: "Queue prompt", category: "Prompt", keybind: "<leader>return", enabled: () => !!agentId(), run: () => void getPrompt()?.submit("queue") },
    { id: "prompt.queue.list", title: "View queued prompts", category: "Prompt", slash: "queue", enabled: () => queueOf(agentId()).length > 0, run: openQueue },
  ])

  sendQueued((id: string, item: PromptSubmit) => {
    const images = item.images.length ? item.images : undefined
    const messageId = crypto.randomUUID()
    rememberImages(messageId, images)
    api.agents
      .ref(id)
      .send(item.text, { messageId, images })
      .catch((error) => {
        // Putting it back in the queue would retry forever; the stash keeps the text.
        pushStash({ ...item, pasted: [] })
        showError(new Error(`Queued prompt not sent (${error instanceof Error ? error.message : error}); it is in the stash (/unstash)`))
      })
  })
}
