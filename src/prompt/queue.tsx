import { createEffect, createSignal, Show } from "solid-js"
import { active, agents } from "../paseo"
import { SplitBorder } from "../session"
import { theme } from "../theme"
import type { PromptSubmit } from "./types"

// OpenCode's prompt.queue (MIT): prompts held while a turn runs, sent one per finished turn. Per session, in memory only.
const [queues, setQueues] = createSignal<Record<string, PromptSubmit[]>>({})

export const queueOf = (id: string | undefined): PromptSubmit[] => (id && queues()[id]) || []
const update = (id: string, change: (list: PromptSubmit[]) => PromptSubmit[]) => setQueues((all) => ({ ...all, [id]: change(all[id] ?? []) }))
export const enqueue = (id: string, item: PromptSubmit) => update(id, (list) => [...list, item])
export const dequeue = (id: string, index: number) => update(id, (list) => list.filter((_, i) => i !== index))

/**
 * Sends each session's next queued prompt when its turn ends: it was seen running, and is now idle with no
 * permission pending. One per turn: the next waits for the turn that one starts. An errored turn keeps its queue.
 */
export function sendQueued(send: (id: string, item: PromptSubmit) => unknown) {
  const running = new Set<string>()
  createEffect(() => {
    for (const [id, list] of Object.entries(queues())) {
      const agent = agents[id]
      if (!agent || !list.length) continue
      if (agent.status === "running") running.add(id)
      else if (running.has(id) && agent.status === "idle" && !active(agent)) {
        running.delete(id)
        dequeue(id, 0)
        send(id, list[0]!)
      }
    }
  })
}

/** OpenCode's QueuedPromptDock: "N queued · next prompt"; clicking opens the list. */
export function QueueDock(props: { sessionId: string | undefined; onOpen: () => void }) {
  const [hover, setHover] = createSignal(false)
  const list = () => queueOf(props.sessionId)
  return (
    <Show when={list().length}>
      <box marginBottom={1} border={["left"]} borderColor={theme.border} customBorderChars={SplitBorder} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)} onMouseUp={props.onOpen}>
        <box width="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={1} backgroundColor={hover() ? theme.backgroundPanelHover : theme.backgroundPanel} flexDirection="row">
          <text fg={theme.textMuted} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
            <span style={{ fg: theme.text }}>{list().length} queued</span> · {list()[0]!.text.replaceAll("\n", " ")}
          </text>
        </box>
      </box>
    </Show>
  )
}
