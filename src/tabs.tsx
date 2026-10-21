// Session tabs, after OpenCode's component/session-tabs.tsx + context/session-tabs.tsx (MIT): a one-line bar of the
// sessions opened here (persisted in kv), with run/permission/error/unread markers, <leader>1..9 and <leader>. / <leader>,.
import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { registerCommands } from "./commands"
import { kvGet, kvSet } from "./config"
import { truncate } from "./dialog"
import { agents, sessionTitle } from "./paseo"
import { Spinner } from "./session"
import { agentId, navigate, prefs } from "./state"
import { closeTab, cycleTab, openTab, tabLayout, TAB_BAR_MIN_COLUMNS } from "./tabs-model"
import { theme } from "./theme"

const [open, setOpen] = createSignal<readonly string[]>(kvGet("tabs", []))
const save = (ids: readonly string[]) => (setOpen(ids), kvSet("tabs", ids))

/** Open tabs whose session still exists; archived or removed ones drop out. */
export const tabs = () => open().filter((id) => agents[id])

function closeCurrent() {
  const id = agentId()
  if (!id) return
  const closed = closeTab(tabs(), id)
  save(closed.tabs)
  navigate(closed.next)
}

/** Tracks the sessions you open and registers the tab commands; call once from App (effects need its owner). */
export function registerTabs() {
  createEffect(
    on([agentId, () => prefs.tabs], ([id, enabled]) => {
      if (!id || !enabled || !agents[id]) return
      const next = openTab(open(), id)
      if (next !== open()) save(next)
    }),
  )
  // The list persists across restarts and the daemon may have archived sessions meanwhile; the guard skips a not-yet-synced store.
  createEffect(() => {
    const live = tabs()
    if (live.length !== open().length && Object.keys(agents).length) save(live)
  })
  const cycle = (direction: 1 | -1) => () => {
    const id = cycleTab(tabs(), agentId(), direction)
    if (id) navigate(id)
  }
  const many = () => prefs.tabs && tabs().length > 1
  registerCommands([
    { id: "session.tab.next", title: "Next tab", category: "Session", keybind: "<leader>.", enabled: many, run: cycle(1) },
    { id: "session.tab.previous", title: "Previous tab", category: "Session", keybind: "<leader>,", enabled: many, run: cycle(-1) },
    { id: "session.tab.close", title: "Close tab", category: "Session", slash: "close-tab", enabled: () => prefs.tabs && !!agentId() && tabs().includes(agentId()!), run: closeCurrent },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `session.tab.select.${index + 1}`,
      title: `Switch to tab ${index + 1}`,
      category: "Session",
      keybind: `<leader>${index + 1}`,
      hidden: true,
      enabled: () => prefs.tabs && !!tabs()[index],
      run: () => navigate(tabs()[index]),
    })),
  ])
}

type Marker = "permission" | "running" | "error" | "unread"

function Tab(props: { id: string; number: number; width: number }) {
  const active = () => props.id === agentId()
  const marker = createMemo((): Marker | undefined => {
    const agent = agents[props.id]
    if (agent?.pendingPermissions?.length) return "permission"
    if (agent?.status === "running") return "running"
    if (agent?.status === "error") return "error"
    if (agent?.requiresAttention && !active()) return "unread"
  })
  const numbered = () => props.number <= 9
  const title = () => truncate((agents[props.id] && sessionTitle(agents[props.id]!)) || "Untitled", props.width - 3 - (numbered() ? 2 : 0))
  return (
    <box width={props.width} height={1} flexShrink={0} flexDirection="row" paddingLeft={1} backgroundColor={active() ? theme.backgroundElement : undefined} onMouseUp={() => navigate(props.id)}>
      <text flexGrow={1} wrapMode="none" fg={active() ? theme.text : theme.textMuted} attributes={active() ? TextAttributes.BOLD : undefined}>
        {numbered() ? `${props.number} ` : ""}
        {title()}
      </text>
      <box width={2} flexShrink={0} paddingRight={1}>
        <Switch>
          <Match when={marker() === "permission"}>
            <text fg={theme.warning}>△</text>
          </Match>
          <Match when={marker() === "running"}>
            <Spinner color={theme.primary} />
          </Match>
          <Match when={marker() === "error"}>
            <text fg={theme.error}>✕</text>
          </Match>
          <Match when={marker() === "unread"}>
            <text fg={theme.success}>●</text>
          </Match>
        </Switch>
      </box>
    </box>
  )
}

export function TabBar() {
  const [width, setWidth] = createSignal(0)
  let start = 0
  const shown = () => prefs.tabs && width() >= TAB_BAR_MIN_COLUMNS && tabs().length > 1
  const layout = createMemo(() => {
    const ids = tabs()
    const result = tabLayout(ids.length, ids.indexOf(agentId()!), width(), start)
    start = result.start
    return result
  })
  const visible = createMemo(() => tabs().slice(layout().start, layout().start + layout().shown))
  return (
    <box width="100%" height={shown() ? 1 : 0} flexShrink={0} flexDirection="row" overflow="hidden" onSizeChange={function () { setWidth(this.width) }}>
      <Show when={shown()}>
        <Show when={layout().before}>
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>{`‹${layout().before} `}</text>
        </Show>
        <For each={visible()}>{(id, index) => <Tab id={id} number={layout().start + index() + 1} width={layout().width} />}</For>
        <Show when={layout().after}>
          <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>{` ${layout().after}›`}</text>
        </Show>
      </Show>
    </box>
  )
}
