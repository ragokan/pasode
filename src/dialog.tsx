import { RGBA, TextAttributes, type InputRenderable, type KeyEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js"
import { theme } from "./theme"

// Ported in spirit from OpenCode's ui/dialog.tsx + ui/dialog-select.tsx (MIT), trimmed to what we use.

type Size = "medium" | "large"
const [current, setCurrent] = createSignal<{ render: () => JSX.Element; size: Size; onClose?: () => void }>()

export const dialog = {
  get isOpen() {
    return current() !== undefined
  },
  replace(render: () => JSX.Element, size: Size = "medium", onClose?: () => void) {
    current()?.onClose?.()
    setCurrent({ render, size, onClose })
  },
  clear() {
    const closing = current()
    setCurrent(undefined)
    closing?.onClose?.()
  },
}

export function DialogHost() {
  const dimensions = useTerminalDimensions()
  useKeyboard((key) => {
    if (!dialog.isOpen || key.defaultPrevented) return
    if (key.name !== "escape" && !(key.ctrl && key.name === "c")) return
    key.preventDefault()
    dialog.clear()
  })
  return (
    <Show when={current()}>
      {(open) => (
        <box
          position="absolute"
          left={0}
          top={0}
          zIndex={3000}
          width={dimensions().width}
          height={dimensions().height}
          alignItems="center"
          paddingTop={Math.floor(dimensions().height / 4)}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          onMouseUp={() => dialog.clear()}
        >
          <box
            width={open().size === "large" ? 88 : 60}
            maxWidth={dimensions().width - 2}
            backgroundColor={theme.backgroundPanel}
            paddingTop={1}
            onMouseUp={(e: { stopPropagation(): void }) => e.stopPropagation()}
          >
            {open().render()}
          </box>
        </box>
      )}
    </Show>
  )
}

export interface SelectOption<T> {
  title: string
  value: T
  category?: string
  description?: string
  footer?: string
  gutter?: () => JSX.Element
  bg?: RGBA
}

export interface SelectAction<T> {
  /** Shown in the footer, e.g. "ctrl+d". */
  label: string
  title: string
  match: (key: KeyEvent) => boolean
  run: (option: SelectOption<T>, key: KeyEvent) => void
}

export function DialogSelect<T>(props: {
  title: string
  placeholder?: string
  emptyText?: string
  options: SelectOption<T>[]
  current?: T
  onSelect: (option: SelectOption<T>) => void
  onMove?: (option: SelectOption<T>) => void
  actions?: SelectAction<T>[]
  /** false hides the search field (short lists such as /mcps). */
  search?: boolean
  /** Typed text, for callers that filter the options themselves (e.g. a daemon search); they are then listed as given. */
  onFilter?: (value: string) => void
}) {
  const dimensions = useTerminalDimensions()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  let scroll: ScrollBoxRenderable | undefined

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase()
    if (!needle || props.onFilter) return props.options
    return props.options.filter((option) => fuzzy(needle, `${option.title} ${option.category ?? ""}`.toLowerCase()))
  })
  // Keep category order as given; filtering flattens nothing, it just hides misses.
  const grouped = createMemo(() => {
    const groups: [string, { option: SelectOption<T>; index: number }[]][] = []
    filtered().forEach((option, index) => {
      const category = option.category ?? ""
      const last = groups.at(-1)
      if (last && last[0] === category) last[1].push({ option, index })
      else groups.push([category, [{ option, index }]])
    })
    return groups
  })
  const rows = createMemo(() => filtered().length + grouped().filter(([c]) => c).length * 2)
  const height = createMemo(() => Math.max(1, Math.min(rows(), Math.floor(dimensions().height / 2) - 6)))

  createEffect(
    on(filter, () => {
      const index = filter() ? 0 : Math.max(0, filtered().findIndex((option) => option.value === props.current))
      moveTo(index)
    }),
  )
  // Keep the cursor inside the list when options change underneath it (live session updates).
  createEffect(() => {
    if (selected() >= filtered().length) setSelected(Math.max(0, filtered().length - 1))
  })

  function moveTo(index: number) {
    setSelected(index)
    const option = filtered()[index]
    if (option) props.onMove?.(option)
    setTimeout(() => scroll?.scrollChildIntoView(`dialog-option-${index}`), 0)
  }
  function move(delta: number) {
    const total = filtered().length
    if (!total) return
    moveTo((((selected() + delta) % total) + total) % total)
  }
  function submit(option = filtered()[selected()]) {
    if (option) props.onSelect(option)
  }

  useKeyboard((key) => {
    if (key.defaultPrevented) return
    const handled = (() => {
      if (key.name === "up" || (key.ctrl && key.name === "p")) return move(-1), true
      if (key.name === "down" || (key.ctrl && key.name === "n")) return move(1), true
      if (key.name === "pageup") return move(-10), true
      if (key.name === "pagedown") return move(10), true
      if (key.name === "return") return submit(), true
      const action = props.actions?.find((item) => item.match(key))
      const option = filtered()[selected()]
      if (action && option) return action.run(option, key), true
      return false
    })()
    if (handled) key.preventDefault()
  })

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={4} paddingRight={4}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {props.title}
          </text>
          <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
            esc
          </text>
        </box>
        <Show when={props.search !== false}>
          <box paddingTop={1}>
            <input
              focused
              onInput={(value) => (setFilter(value), props.onFilter?.(value))}
              placeholder={props.placeholder ?? "Search"}
              placeholderColor={theme.textMuted}
              textColor={theme.textMuted}
              focusedTextColor={theme.textMuted}
              backgroundColor={theme.backgroundPanel}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
            />
          </box>
        </Show>
      </box>
      <Show
        when={filtered().length > 0}
        fallback={
          <box paddingLeft={4}>
            <text fg={theme.textMuted}>{props.options.length ? "No results found" : (props.emptyText ?? "Nothing here")}</text>
          </box>
        }
      >
        <scrollbox ref={(r: ScrollBoxRenderable) => (scroll = r)} paddingLeft={1} paddingRight={1} height={height()} scrollbarOptions={{ visible: false }}>
          <For each={grouped()}>
            {([category, items], groupIndex) => (
              <>
                <Show when={category}>
                  <box paddingTop={groupIndex() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      {category}
                    </text>
                  </box>
                </Show>
                <For each={items}>
                  {({ option, index }) => {
                    const active = () => index === selected()
                    const isCurrent = () => props.current !== undefined && option.value === props.current
                    const fg = () => (active() ? theme.selectedListItemText : isCurrent() ? theme.primary : theme.text)
                    return (
                      <box
                        id={`dialog-option-${index}`}
                        flexDirection="row"
                        gap={1}
                        paddingLeft={isCurrent() || option.gutter ? 1 : 3}
                        paddingRight={3}
                        backgroundColor={active() ? (option.bg ?? theme.primary) : RGBA.fromInts(0, 0, 0, 0)}
                        onMouseOver={() => setSelected(index)}
                        onMouseUp={() => submit(option)}
                      >
                        <Show when={option.gutter} fallback={<Show when={isCurrent()}><text fg={fg()}>●</text></Show>}>
                          {option.gutter!()}
                        </Show>
                        <text flexGrow={1} fg={fg()} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" overflow="hidden">
                          {truncate(option.title, 61)}
                          <Show when={option.description}>
                            <span style={{ fg: active() ? theme.selectedListItemText : theme.textMuted }}> {option.description}</span>
                          </Show>
                        </text>
                        <Show when={option.footer}>
                          <text flexShrink={0} fg={active() ? theme.selectedListItemText : theme.textMuted}>
                            {option.footer}
                          </text>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.actions?.length}>
        <box paddingLeft={4} flexDirection="row" gap={2}>
          <For each={props.actions}>
            {(action) => (
              <text>
                <span style={{ fg: theme.text }}>
                  <b>{action.title}</b>{" "}
                </span>
                <span style={{ fg: theme.textMuted }}>{action.label}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function DialogHeader(props: { title: string }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
        esc
      </text>
    </box>
  )
}

/** OpenCode's dialog-confirm: ←/→ pick, enter confirms. */
export function DialogConfirm(props: { title: string; message: string; label?: string; onDone: (ok: boolean) => void }) {
  const [ok, setOk] = createSignal(true)
  useKeyboard((key) => {
    if (key.defaultPrevented) return
    if (key.name === "left" || key.name === "right" || key.name === "tab") setOk((value) => !value)
    else if (key.name === "return") props.onDone(ok())
    else return
    key.preventDefault()
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} />
      <text fg={theme.textMuted}>{props.message}</text>
      <box flexDirection="row" justifyContent="flex-end" gap={1}>
        <For each={[false, true]}>
          {(value) => (
            <box paddingLeft={1} paddingRight={1} backgroundColor={ok() === value ? theme.primary : undefined} onMouseUp={() => props.onDone(value)}>
              <text fg={ok() === value ? theme.selectedListItemText : theme.textMuted}>{value ? (props.label ?? "Confirm") : "Cancel"}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

/** OpenCode's dialog-prompt: one text field, enter submits. */
export function DialogPrompt(props: { title: string; description?: string; placeholder?: string; value?: string; onDone: (value?: string) => void }) {
  let field: InputRenderable | undefined
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} />
      <Show when={props.description}>
        <text fg={theme.textMuted}>{props.description}</text>
      </Show>
      <input
        focused
        value={props.value ?? ""}
        placeholder={props.placeholder ?? ""}
        placeholderColor={theme.textMuted}
        textColor={theme.text}
        focusedTextColor={theme.text}
        backgroundColor={theme.backgroundElement}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        ref={(r: InputRenderable) => (field = r)}
        onSubmit={() => props.onDone(field?.value)}
      />
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>enter</span> submit
      </text>
    </box>
  )
}

export function DialogAlert(props: { title: string; message: string; onDone: () => void }) {
  useKeyboard((key) => {
    if (key.defaultPrevented || key.name !== "return") return
    key.preventDefault()
    props.onDone()
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} />
      <text fg={theme.text}>{props.message}</text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>enter</span> ok
      </text>
    </box>
  )
}

/** Promise helpers (plugins get these through ctx.ui.dialog). Escape resolves to undefined/false. */
export const dialogs = {
  confirm(title: string, message: string, label?: string) {
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        resolve(ok)
        dialog.clear()
      }
      dialog.replace(() => <DialogConfirm title={title} message={message} label={label} onDone={finish} />, "medium", () => finish(false))
    })
  },
  prompt(options: { title: string; description?: string; placeholder?: string; value?: string }) {
    return new Promise<string | undefined>((resolve) => {
      let done = false
      const finish = (value?: string) => {
        if (done) return
        done = true
        resolve(value)
        dialog.clear()
      }
      dialog.replace(() => <DialogPrompt {...options} onDone={finish} />, "medium", () => finish(undefined))
    })
  },
  alert(title: string, message: string, size: Size = "medium") {
    return new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
        dialog.clear()
      }
      dialog.replace(() => <DialogAlert title={title} message={message} onDone={finish} />, size, finish)
    })
  },
  select<T>(options: { title: string; placeholder?: string; options: SelectOption<T>[]; current?: T; size?: Size }) {
    return new Promise<T | undefined>((resolve) => {
      let done = false
      const finish = (value?: T) => {
        if (done) return
        done = true
        resolve(value)
        dialog.clear()
      }
      dialog.replace(
        () => <DialogSelect title={options.title} placeholder={options.placeholder} options={options.options} current={options.current} onSelect={(option) => finish(option.value)} />,
        options.size ?? "medium",
        () => finish(undefined),
      )
    })
  },
}

function fuzzy(needle: string, haystack: string) {
  let at = 0
  for (const char of needle) {
    at = haystack.indexOf(char, at)
    if (at < 0) return false
    at++
  }
  return true
}

export function truncate(value: string, max: number) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}
