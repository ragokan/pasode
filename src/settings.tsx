// OpenCode 2.0.26 component/dialog-config.tsx (MIT): the settings pasode honors, cycled with ←/→.
// Values persist like the other runtime choices (kv.json); cli.json `session.*` / `theme.*` are the defaults.
import { createResource } from "solid-js"
import { DialogSelect } from "./dialog"
import { prefs, setPref, showError, type Prefs } from "./state"
import { applyTheme } from "./theme"
import { listThemes, loadTheme } from "./themes"

type Setting = { title: string; category: string; key: keyof Prefs; values?: readonly unknown[]; labels?: readonly string[] }

const onOff = { values: [false, true], labels: ["off", "on"] }

export const settings: Setting[] = [
  { title: "Theme", category: "Appearance", key: "theme" },
  { title: "Color mode", category: "Appearance", key: "themeMode", values: ["dark", "light"] },
  { title: "Animations", category: "Appearance", key: "animations", ...onOff },
  { title: "Sidebar", category: "Session", key: "sidebar", values: ["hide", "auto", "show"] },
  { title: "Scrollbar", category: "Session", key: "scrollbar", ...onOff },
  { title: "Thinking", category: "Session", key: "thinking", values: ["hide", "show"] },
  { title: "Markdown", category: "Session", key: "markdown", values: ["source", "rendered"] },
  { title: "Tool grouping", category: "Session", key: "grouping", values: ["none", "auto"] },
  { title: "Verbosity", category: "Session", key: "verbosity", values: ["low", "medium", "high"] },
  { title: "Transcript images", category: "Session", key: "images", ...onOff },
  { title: "TPS", category: "Session", key: "tps", ...onOff },
  { title: "New session location", category: "Session", key: "newLocation", values: ["launch", "inherit"], labels: ["launch directory", "active session"] },
  { title: "Permissions", category: "Session", key: "permissions", values: ["prompt", "bypass"] },
  { title: "Layout", category: "Diffs", key: "diffs", values: ["auto", "split", "unified"] },
  { title: "Wrapping", category: "Diffs", key: "diffWrap", values: ["none", "word"] },
  { title: "Mouse", category: "Input", key: "mouse", ...onOff },
  { title: "Notifications", category: "Alerts", key: "notifications", ...onOff },
  { title: "Window title", category: "Terminal", key: "terminalTitle", ...onOff },
  { title: "Copy on select", category: "Terminal", key: "copyOnSelect", ...onOff },
]

export function nextValue(values: readonly unknown[], current: unknown, direction: number) {
  return values[(values.indexOf(current) + direction + values.length) % values.length]
}

export function settingLabel(setting: Setting, value: unknown) {
  const index = setting.values?.indexOf(value) ?? -1
  return index < 0 ? String(value) : (setting.labels?.[index] ?? String(value))
}

export function DialogSettings() {
  const [themes] = createResource(() =>
    listThemes()
      .then((list) => list.map((theme) => theme.name).toSorted((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })))
      .catch(() => [prefs.theme]),
  )
  function change(index: number, direction: number) {
    const setting = settings[index]!
    const next = nextValue(setting.key === "theme" ? (themes() ?? [prefs.theme]) : setting.values!, prefs[setting.key], direction)
    setPref(setting.key, next as never)
    if (setting.key === "theme" || setting.key === "themeMode") void loadTheme(prefs.theme, prefs.themeMode).then(applyTheme, showError)
  }
  return (
    <DialogSelect
      title="Settings"
      options={settings.map((setting, index) => ({ title: setting.title, category: setting.category, footer: settingLabel(setting, prefs[setting.key]), value: index }))}
      onSelect={(option) => change(option.value, 1)}
      actions={[{ title: "←/→", label: "change", match: (key) => key.name === "left" || key.name === "right", run: (option, key) => change(option.value, key.name === "left" ? -1 : 1) }]}
    />
  )
}
