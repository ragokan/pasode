// Full-screen changes view (/changes, <leader>v): the session directory's live git diff, file by file, with
// commit/push/pull/discard and the PR dialog. Layout after OpenCode's diff viewer (MIT), over the daemon's diff stream.
import { TextAttributes, type DiffRenderable, type KeyEvent, type PasteEvent, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { commands, isEnabled, runCommand } from "../commands"
import { dialog } from "../dialog"
import { filetype } from "../render/helpers"
import { Spinner } from "../session"
import { current, notify, prefs } from "../state"
import { paneFocused } from "../terminal"
import { syntax, theme } from "../theme"
import { useCheckoutDiff, useCheckoutStatus, type DiffCompare } from "./live"
import { branchLabel, canCommit, canPull, canPush, kindOf, patchOf, pathsOf, totals } from "./model"
import { commit, discard, pull, push } from "./ops"
import { openPr } from "./pr"

const [open, setOpen] = createSignal(false)
export const openChanges = () => setOpen(true)
export const closeChanges = () => setOpen(false)

/** Mounted once by App; shows while open and a session is active. */
export function ChangesView() {
  // A session that goes away closes the view for good, so the next session doesn't open into it.
  createEffect(() => !current() && setOpen(false))
  return <Show when={open() ? current()?.cwd : undefined}>{(cwd) => <Changes cwd={cwd()} />}</Show>
}

const kindColor = { A: () => theme.diffAdded, D: () => theme.diffRemoved, R: () => theme.warning, M: () => theme.textMuted }

function Changes(props: { cwd: string }) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const status = useCheckoutStatus(() => props.cwd)
  const [mode, setMode] = createSignal<"uncommitted" | "base">("uncommitted")
  const baseRef = createMemo(() => status()?.baseRef ?? undefined)
  const compare = createMemo<DiffCompare>(() => (mode() === "base" ? { mode: "base", baseRef: baseRef() } : { mode: "uncommitted" }))
  const diff = useCheckoutDiff(() => props.cwd, compare)
  const [picked, setPicked] = createSignal<string>()
  const index = createMemo(() => Math.max(0, diff.files.findIndex((file) => file.path === picked())))
  const file = () => diff.files[index()]
  const sum = createMemo(() => totals(diff.files))
  const listWidth = () => Math.min(44, Math.max(24, Math.floor(dimensions().width / 3)))
  const split = () => prefs.diffs === "split" || (prefs.diffs === "auto" && dimensions().width - listWidth() - 6 > 120)
  let list: ScrollBoxRenderable | undefined
  let pane: ScrollBoxRenderable | undefined
  let patch: DiffRenderable | undefined

  createEffect(on(() => file()?.path, () => pane?.scrollTo(0)))
  createEffect(on(index, (at) => setTimeout(() => list?.scrollChildIntoView(`change-file-${at}`), 0)))
  // A new comparison starts at the first file.
  createEffect(on(mode, () => setPicked(undefined), { defer: true }))

  const select = (delta: number) => {
    const total = diff.files.length
    if (total) setPicked(diff.files[(((index() + delta) % total) + total) % total]!.path)
  }
  /** Jumps the diff pane to the next/previous hunk (needs one row per line, hence no wrapping). */
  const hunk = (delta: number) => {
    const rows = patch?.getHunkRowOffsets() ?? []
    const top = pane?.scrollTop ?? 0
    const target = delta > 0 ? rows.find((row) => row > top) : rows.findLast((row) => row < top)
    if (target !== undefined) pane?.scrollTo(target)
  }
  const unless = (reason: string | undefined, run: () => unknown) => (reason ? notify(reason, "warning") : void run())
  const actions = {
    commit: () => unless(!canCommit(status()!) ? "Nothing to commit" : undefined, () => commit(props.cwd)),
    push: () => unless(!canPush(status()!) ? "Nothing to push (no remote, nothing ahead, or behind the remote: pull first)" : undefined, () => push(props.cwd)),
    pull: () => unless(!canPull(status()!) ? "Nothing to pull (no remote, behind by 0, or uncommitted changes)" : undefined, () => pull(props.cwd)),
    discard: () => unless(mode() === "base" ? "Switch to uncommitted changes (tab) to discard" : !file() ? "No file selected" : undefined, () => discard(props.cwd, pathsOf([file()!]), file()!.path)),
    discardAll: () => unless(mode() === "base" ? "Switch to uncommitted changes (tab) to discard" : !diff.files.length ? "No changes to discard" : undefined, () => discard(props.cwd, pathsOf(diff.files), `all ${diff.files.length} changed files`)),
    pr: () => openPr(props.cwd),
  }

  const onKey = (key: KeyEvent) => {
    // Confirm and prompt dialogs own the keyboard while they're up.
    if (dialog.isOpen) return
    key.preventDefault()
    key.stopPropagation()
    if (key.ctrl && key.name === "c") return closeChanges()
    // Chords (ctrl+p palette, ctrl+d exit, alt+…) belong to the app: swallowed, never an action here.
    if (key.ctrl || key.meta || key.option || key.super || key.hyper) return
    // Shift makes a letter another key (d discards a file, D all of them; shift+c is not c).
    const name = key.shift && key.name.length === 1 ? key.name.toUpperCase() : key.name
    if (name === "escape" || name === "q") return closeChanges()
    if (!status()) return
    if (name === "up" || name === "k") select(-1)
    else if (name === "down" || name === "j") select(1)
    else if (name === "]") hunk(1)
    else if (name === "[") hunk(-1)
    else if (name === "pagedown") pane?.scrollBy(Math.max(1, pane.height - 2))
    else if (name === "pageup") pane?.scrollBy(-Math.max(1, pane.height - 2))
    else if (name === "tab") setMode((value) => (value === "base" ? "uncommitted" : "base"))
    else if (name === "c") actions.commit()
    else if (name === "p") actions.push()
    else if (name === "u") actions.pull()
    else if (name === "d") actions.discard()
    else if (name === "D") actions.discardAll()
    else if (name === "r") actions.pr()
  }
  // Pastes would reach the focused prompt or terminal, which runs them (a shell executes pasted lines).
  const onPaste = (event: PasteEvent) => {
    if (dialog.isOpen) return
    event.preventDefault()
    event.stopPropagation()
  }
  // Ahead of App's own handlers (and the prompt's), so this view is modal.
  onMount(() => {
    renderer.keyInput.prependListener("keypress", onKey)
    renderer.keyInput.prependListener("paste", onPaste)
  })
  onCleanup(() => {
    renderer.keyInput.off("keypress", onKey)
    renderer.keyInput.off("paste", onPaste)
  })
  // A focused terminal pane is released while this view is up, and focused again on close (if it's still there).
  const hadPane = paneFocused()
  if (hadPane) runCommand("terminal.toggle")
  onCleanup(() => hadPane && !paneFocused() && commands().some((command) => command.id === "terminal.close" && isEnabled(command)) && runCommand("terminal.toggle"))

  const hints = createMemo(() => {
    const s = status()
    return [
      ["↑↓", "files", undefined],
      ["[ ]", "hunks", undefined],
      ["tab", mode() === "base" ? "uncommitted" : "vs base", () => setMode((value) => (value === "base" ? "uncommitted" : "base"))],
      ...(s && canCommit(s) ? [["c", "commit", actions.commit] as const] : []),
      ...(s && canPush(s) ? [["p", "push", actions.push] as const] : []),
      ...(s && canPull(s) ? [["u", "pull", actions.pull] as const] : []),
      ...(mode() === "uncommitted" && diff.files.length ? [["d", "discard file", actions.discard] as const, ["D", "all", actions.discardAll] as const] : []),
      ["r", "PR", actions.pr],
      ["esc", "close", closeChanges],
    ] as readonly (readonly [string, string, (() => void) | undefined])[]
  })

  return (
    <box position="absolute" left={0} top={0} zIndex={2000} width={dimensions().width} height={dimensions().height} backgroundColor={theme.background} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Changes</text>
        <Show when={status()}>{(s) => <text fg={theme.textMuted}>{branchLabel(s())}</text>}</Show>
        <text fg={theme.textMuted}>{mode() === "base" ? `committed vs ${baseRef() ?? "base"}` : "uncommitted"}</text>
        <box flexGrow={1} />
        <Show when={sum().files}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.diffAdded }}>+{sum().additions}</span> <span style={{ fg: theme.diffRemoved }}>−{sum().deletions}</span> · {sum().files} {sum().files === 1 ? "file" : "files"}
          </text>
        </Show>
      </box>
      <Show
        when={status()}
        fallback={<Spinner>Reading git status…</Spinner>}
      >
        {(s) => (
          <Show when={s().isGit} fallback={<text fg={theme.textMuted}>{props.cwd} is not a git repository.</text>}>
            <box flexDirection="row" flexGrow={1} minHeight={0} gap={2}>
              <scrollbox ref={(r: ScrollBoxRenderable) => (list = r)} width={listWidth()} flexShrink={0} scrollbarOptions={{ visible: false }}>
                <For each={diff.files}>
                  {(item, at) => (
                    <box id={`change-file-${at()}`} flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={at() === index() ? theme.primary : undefined} onMouseUp={() => setPicked(item.path)}>
                      <text fg={at() === index() ? theme.selectedListItemText : kindColor[kindOf(item)]()} flexShrink={0}>{kindOf(item)}</text>
                      <text fg={at() === index() ? theme.selectedListItemText : theme.text} flexGrow={1} flexShrink={1} wrapMode="none" overflow="hidden">{item.path}</text>
                      <text flexShrink={0} fg={at() === index() ? theme.selectedListItemText : theme.textMuted}>
                        <Show when={item.additions}><span style={{ fg: at() === index() ? undefined : theme.diffAdded }}>+{item.additions}</span> </Show>
                        <Show when={item.deletions}><span style={{ fg: at() === index() ? undefined : theme.diffRemoved }}>−{item.deletions}</span></Show>
                      </text>
                    </box>
                  )}
                </For>
              </scrollbox>
              <scrollbox ref={(r: ScrollBoxRenderable) => (pane = r)} flexGrow={1} scrollbarOptions={{ visible: false }}>
                <Show
                  when={file()}
                  fallback={
                    <Show when={!diff.loading} fallback={<Spinner>Loading diff…</Spinner>}>
                      <text fg={theme.textMuted}>{diff.error ?? (mode() === "base" ? `No commits on this branch beyond ${baseRef() ?? "its base"}.` : "No uncommitted changes.")}</text>
                    </Show>
                  }
                >
                  {(item) => (
                    <Show
                      when={(item().status ?? "ok") === "ok" && item().hunks.length}
                      fallback={<text fg={theme.textMuted}>{item().status === "too_large" ? "Diff too large to show." : item().status === "binary" ? "Binary file." : "No textual changes (mode change or empty file)."}</text>}
                    >
                      <diff
                        ref={(r: DiffRenderable) => (patch = r)}
                        diff={patchOf(item())} view={split() ? "split" : "unified"} filetype={filetype(item().path)} syntaxStyle={syntax()}
                        width="100%" wrapMode="none" showLineNumbers fg={theme.text}
                        addedBg={theme.diffAddedBg} removedBg={theme.diffRemovedBg} contextBg={theme.diffContextBg}
                        addedSignColor={theme.diffHighlightAdded} removedSignColor={theme.diffHighlightRemoved}
                        lineNumberFg={theme.diffLineNumber} lineNumberBg={theme.diffContextBg}
                        addedLineNumberBg={theme.diffAddedLineNumberBg} removedLineNumberBg={theme.diffRemovedLineNumberBg}
                      />
                    </Show>
                  )}
                </Show>
              </scrollbox>
            </box>
          </Show>
        )}
      </Show>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={hints()}>
          {([key, label, run]) => (
            <text fg={theme.text} wrapMode="none" onMouseUp={run}>
              {key} <span style={{ fg: theme.textMuted }}>{label}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
