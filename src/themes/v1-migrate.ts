// Ported from OpenCode v2.0.26 (MIT), packages/theme/src/tui/v1-migrate.ts.
// Resolution stays in index.ts so incomplete legacy palettes retain this client's fallbacks.
import { RGBA } from "@opentui/core"
import { oklchToHex, rgbToOklch } from "./color.js"
import type { ThemeColors } from "../theme"

type Mode = "dark" | "light"
type HueStep = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
const HueStep = { literals: [100, 200, 300, 400, 500, 600, 700, 800, 900] as const }
type HueDefinition = Record<string, string | Partial<Record<HueStep, string>>>
type ThemeDefinition = Record<string, unknown> & { hue: HueDefinition }
type BaseThemeDefinition = Record<string, unknown>
type ThemeDocument = { base: BaseThemeDefinition; light?: BaseThemeDefinition; dark?: BaseThemeDefinition }
export type LegacyTheme = ThemeColors & { _hasSelectedListItemText: boolean }
type Theme = LegacyTheme

type ThemeColor = Exclude<keyof Theme, "thinkingOpacity" | "_hasSelectedListItemText">
type ChromaticHue = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple"
type V1HueToken = "secondary" | "accent" | "success" | "warning" | "primary" | "error" | "info"

const chromaticHues: readonly ChromaticHue[] = ["red", "orange", "yellow", "green", "cyan", "blue", "purple"]
const categoricalTokens: readonly V1HueToken[] = [
  "secondary",
  "accent",
  "success",
  "warning",
  "primary",
  "error",
  "info",
]
const minimumChroma = 0.03
const lightThreshold = 0.6
// Canonical swatches copied from the original default-theme classifier keep V1 migration self-contained.
const hueReferences = {
  light: {
    red: "#fca5a5",
    orange: "#fdba74",
    yellow: "#fde047",
    green: "#86efac",
    cyan: "#67e8f9",
    blue: "#93c5fd",
    purple: "#d8b4fe",
  },
  dark: {
    red: "#b91c1c",
    orange: "#c2410c",
    yellow: "#a16207",
    green: "#15803d",
    cyan: "#0e7490",
    blue: "#1d4ed8",
    purple: "#7e22ce",
  },
} satisfies Record<"light" | "dark", Record<ChromaticHue, string>>

const hueAngles = Object.fromEntries(
  Object.entries(hueReferences).map(([level, colors]) => [
    level,
    Object.fromEntries(Object.entries(colors).map(([name, color]) => [name, toOklch(RGBA.fromHex(color)).h])),
  ]),
) as Record<"light" | "dark", Record<ChromaticHue, number>>

export function migrateV1(theme: Record<Mode, LegacyTheme>): ThemeDocument {
  const light = theme.light
  const dark = theme.dark
  if (light.background.a > 0 && dark.background.a > 0 && light.background.equals(dark.background)) {
    const lightMode = detectMode(light)
    const darkMode = detectMode(dark)
    if (lightMode === darkMode) {
      const definition = migrateMode(lightMode === "light" ? light : dark, lightMode)
      if (lightMode === "light") return { base: base(definition), light: { hue: definition.hue } }
      return { base: base(definition), dark: { hue: definition.hue } }
    }
  }
  const lightDefinition = migrateMode(light, "light")
  const darkDefinition = migrateMode(dark, "dark")
  return {
    base: base(lightDefinition),
    light: { hue: lightDefinition.hue },
    dark: darkDefinition,
  }
}

function base(definition: ThemeDefinition): BaseThemeDefinition {
  const { hue: _, ...base } = definition
  return base
}

function detectMode(theme: Theme): Mode {
  return luminance(theme.text) > luminance(theme.background) ? "dark" : "light"
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function migrateMode(theme: Theme, mode: Mode): ThemeDefinition {
  const color = (key: ThemeColor) => hex(theme[key])
  const selected = hex(selectedForeground(theme, theme.primary))
  const destructive = hex(selectedForeground(theme, theme.error))
  const hues = inferHues(theme)
  const categorical = categoricalTokens.flatMap((token) => {
    const hue = hues.byToken[token]
    return hue ? [hue] : []
  })
  const uniqueCategorical = categorical.filter((hue, index) => categorical.indexOf(hue) === index)
  const text = "$hue.neutral.200"
  const textMuted = "$hue.neutral.400"
  const primary = "$hue.interactive.200"
  const background = "$hue.neutral.800"
  const backgroundPanel = "$hue.neutral.700"
  const backgroundMenu = "$hue.neutral.600"
  const backgroundRaisedMax = "$hue.neutral.500"

  return referenceHues({
    hue: {
      gray: neutralScale(theme),
      ...Object.fromEntries(
        chromaticHues.flatMap((name) => {
          const match = hues.byHue[name]
          return match ? [[name, hueScale(match.color, mode)]] : []
        }),
      ),
      accent: hues.byToken.accent ? `$hue.${hues.byToken.accent}` : "$hue.gray",
      interactive: hues.byToken.primary ? `$hue.${hues.byToken.primary}` : "$hue.gray",
      neutral: "$hue.gray",
    } as HueDefinition,
    categorical: uniqueCategorical.length ? uniqueCategorical : ["neutral"],
    text: {
      base: text,
      muted: textMuted,
      action: {
        primary: {
          base: "$text.base",
          $disabled: textMuted,
          $focused: selected,
          $selected: primary,
        },
        secondary: { base: "$text.muted", $hovered: "$text.base" },
        destructive: { base: destructive, $disabled: textMuted },
      },
      formfield: {
        base: text,
        $hovered: primary,
        $focused: primary,
        $pressed: primary,
        $disabled: textMuted,
        $selected: primary,
      },
      feedback: {
        error: { base: color("error") },
        warning: { base: color("warning") },
        success: { base: color("success") },
        info: { base: color("info") },
      },
    },
    background: {
      base: background,
      raised: {
        base: backgroundPanel,
        high: backgroundMenu,
        max: backgroundRaisedMax,
      },
      action: {
        primary: { base: "transparent", $hovered: backgroundPanel, $focused: primary, $selected: "transparent" },
        secondary: { base: "transparent" },
        destructive: { base: color("error") },
      },
      formfield: {
        base: "$background.base",
      },
      feedback: {
        error: { base: "$background.base" },
        warning: { base: "$background.base" },
        success: { base: "$background.base" },
        info: { base: "$background.base" },
      },
    },
    border: { base: color("border") },
    scrollbar: { base: color("borderActive") },
    diff: {
      text: {
        added: color("diffAdded"),
        removed: color("diffRemoved"),
        context: color("diffContext"),
        hunkHeader: color("diffHunkHeader"),
      },
      background: {
        added: color("diffAddedBg"),
        removed: color("diffRemovedBg"),
        context: color("diffContextBg"),
      },
      highlight: { added: color("diffHighlightAdded"), removed: color("diffHighlightRemoved") },
      lineNumber: {
        text: color("diffLineNumber"),
        background: {
          added: color("diffAddedLineNumberBg"),
          removed: color("diffRemovedLineNumberBg"),
        },
      },
    },
    syntax: {
      comment: color("syntaxComment"),
      keyword: color("syntaxKeyword"),
      function: color("syntaxFunction"),
      variable: color("syntaxVariable"),
      string: color("syntaxString"),
      number: color("syntaxNumber"),
      type: color("syntaxType"),
      operator: color("syntaxOperator"),
      punctuation: color("syntaxPunctuation"),
    },
    markdown: {
      text: color("markdownText"),
      heading: color("markdownHeading"),
      link: color("markdownLink"),
      linkText: color("markdownLinkText"),
      code: color("markdownCode"),
      blockQuote: color("markdownBlockQuote"),
      emphasis: color("markdownEmph"),
      strong: color("markdownStrong"),
      horizontalRule: color("markdownHorizontalRule"),
      listItem: color("markdownListItem"),
      listEnumeration: color("markdownListEnumeration"),
      image: color("markdownImage"),
      imageText: color("markdownImageText"),
      codeBlock: color("markdownCodeBlock"),
    },
    "@dialog": {
      background: {
        base: "$background.raised.base",
        action: { primary: { $hovered: "$background.raised.high" } },
      },
    },
  })
}

function referenceHues(theme: ThemeDefinition): ThemeDefinition {
  const definitions = theme.hue as Record<string, string | Partial<Record<HueStep, string>>> | undefined
  if (!definitions) return theme
  const scales = new Map<string, Partial<Record<HueStep, string>>>()

  function resolve(name: string, chain: string[] = []): Partial<Record<HueStep, string>> | undefined {
    const cached = scales.get(name)
    if (cached) return cached
    if (chain.includes(name)) return
    const value = definitions?.[name]
    if (!value) return
    if (typeof value !== "string") {
      scales.set(name, value)
      return value
    }
    const target = /^\$hue\.([^.]+)$/.exec(value)?.[1]
    if (!target) return
    const scale = resolve(target, [...chain, name])
    if (scale) scales.set(name, scale)
    return scale
  }

  const references = new Map<string, string>()
  const index = (name: string, overwrite: boolean) => {
    const scale = resolve(name)
    if (!scale) return
    HueStep.literals.forEach((step) => {
      const color = scale[step]
      if (!color || (!overwrite && references.has(color.toLowerCase()))) return
      references.set(color.toLowerCase(), `$hue.${name}.${step}`)
    })
  }
  chromaticHues.forEach((name) => index(name, false))
  index("gray", false)
  index("accent", true)
  index("interactive", true)
  index("neutral", true)

  function replace(value: unknown): unknown {
    if (typeof value === "string") return references.get(value.toLowerCase()) ?? value
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
  }

  return Object.fromEntries(
    Object.entries(theme).map(([key, value]) => [key, key === "hue" || key === "categorical" ? value : replace(value)]),
  ) as ThemeDefinition
}

function inferHues(theme: Theme) {
  const colors: readonly [V1HueToken, RGBA][] = [
    ["accent", theme.accent],
    ["success", theme.success],
    ["warning", theme.warning],
    ["primary", theme.primary],
    ["error", theme.error],
    ["info", theme.info],
    ["secondary", theme.secondary],
  ]
  const inferred = colors.reduce<{
    byHue: Partial<Record<ChromaticHue, { color: RGBA; distance: number }>>
    byToken: Partial<Record<V1HueToken, ChromaticHue>>
  }>(
    (result, [token, color]) => {
      const nearest = inferHue(color)
      if (!nearest) return result
      const current = result.byHue[nearest.name]
      return {
        byHue:
          current && current.distance <= nearest.distance
            ? result.byHue
            : { ...result.byHue, [nearest.name]: { color, distance: nearest.distance } },
        byToken: { ...result.byToken, [token]: nearest.name },
      }
    },
    { byHue: {}, byToken: {} },
  )
  return (
    [
      ["accent", theme.accent],
      ["primary", theme.primary],
    ] as const
  ).reduce((result, [token, color]) => {
    const nearest = inferHue(color)
    if (!nearest) return result
    return {
      byHue: { ...result.byHue, [nearest.name]: { color, distance: nearest.distance } },
      byToken: { ...result.byToken, [token]: nearest.name },
    }
  }, inferred)
}

function inferHue(color: RGBA) {
  const value = toOklch(color)
  if (ambiguous(color, value.c)) return
  const reference = value.l >= lightThreshold ? hueAngles.light : hueAngles.dark
  return chromaticHues
    .map((name) => ({
      name,
      distance: hueDistance(value.h, reference[name]),
    }))
    .sort((first, second) => first.distance - second.distance)[0]
}

function hueDistance(first: number, second: number) {
  const difference = Math.abs(first - second)
  return Math.min(difference, 360 - difference)
}

function ambiguous(color: RGBA, chroma = toOklch(color).c) {
  return color.toInts()[3] === 0 || chroma < minimumChroma
}

function selectedForeground(theme: Theme, background: RGBA) {
  if (theme._hasSelectedListItemText) return theme.selectedListItemText
  if (theme.background.a !== 0) return theme.background
  return 0.299 * background.r + 0.587 * background.g + 0.114 * background.b > 0.5
    ? RGBA.fromInts(0, 0, 0)
    : RGBA.fromInts(255, 255, 255)
}

function hueScale(color: RGBA, mode: "light" | "dark") {
  const value = toOklch(color)
  const anchor = 200
  const endpoint = mode === "light" ? Math.max(0.97, value.l) : Math.min(0.18, value.l)
  const alpha = color.toInts()[3]
  return Object.fromEntries(
    HueStep.literals.map((step) => {
      if (step === anchor) return [step, hex(color)]
      const progress = (step - anchor) / (900 - anchor)
      const generated = oklchToHex({
        l: value.l + (endpoint - value.l) * progress,
        c: value.c * (1 - progress * 0.5),
        h: value.h,
      })
      return [step, alpha === 255 ? generated : `${generated}${byte(alpha)}`]
    }),
  ) as Record<HueStep, string>
}

function neutralScale(theme: Theme) {
  const anchors = neutralAnchors(theme)
  return Object.fromEntries(
    HueStep.literals.map((step) => {
      const exact = anchors.find((anchor) => anchor.step === step)
      if (exact) return [step, hex(exact.color)]
      const first = anchors[0]!
      const last = anchors.at(-1)!
      const [lower, upper] =
        step < first.step
          ? [first, anchors[1]!]
          : step > last.step
            ? [anchors.at(-2)!, last]
            : [anchors.filter((anchor) => anchor.step < step).at(-1)!, anchors.find((anchor) => anchor.step > step)!]
      return [step, interpolate(lower.color, upper.color, (step - lower.step) / (upper.step - lower.step))]
    }),
  ) as Record<HueStep, string>
}

function neutralAnchors(theme: Theme) {
  const light: { step: HueStep; color: RGBA }[] = [
    { step: 200, color: theme.background },
    { step: 300, color: theme.backgroundPanel },
    { step: 400, color: theme.backgroundElement || theme.backgroundMenu },
    { step: 600, color: theme.textMuted },
    { step: 800, color: theme.text },
  ]
  return light.toReversed().map((source) => ({ ...source, step: (1000 - source.step) as HueStep }))
}

function interpolate(first: RGBA, second: RGBA, amount: number) {
  const start = toOklch(first)
  const end = toOklch(second)
  const startHue = Number.isFinite(start.h) ? start.h : Number.isFinite(end.h) ? end.h : 0
  const endHue = Number.isFinite(end.h) ? end.h : startHue
  const hue = ((((endHue - startHue) % 360) + 540) % 360) - 180
  const generated = oklchToHex({
    l: start.l + (end.l - start.l) * amount,
    c: start.c + (end.c - start.c) * amount,
    h: startHue + hue * amount,
  })
  const alpha = Math.max(
    0,
    Math.min(255, Math.round(first.toInts()[3] + (second.toInts()[3] - first.toInts()[3]) * amount)),
  )
  return alpha === 255 ? generated : `${generated}${byte(alpha)}`
}

function toOklch(color: RGBA) {
  const [red, green, blue] = color.toInts()
  return rgbToOklch(red / 255, green / 255, blue / 255)
}

function hex(color: RGBA) {
  return hexInts(...color.toInts())
}

function hexInts(r: number, g: number, b: number, a: number) {
  return `#${byte(r)}${byte(g)}${byte(b)}${a === 255 ? "" : byte(a)}`
}

function byte(value: number) {
  return value.toString(16).padStart(2, "0")
}
