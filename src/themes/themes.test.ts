import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { ristretto } from "../theme"
import { listThemes, loadTheme, resolveThemeJson } from "./index"

const keys = Object.keys(ristretto) as (keyof typeof ristretto)[]
const assets = (await readdir(join(import.meta.dir, "assets"))).filter((name) => name.endsWith(".json"))

describe("built-in themes", () => {
  test("ships all 33 OpenCode themes", () => expect(assets).toHaveLength(33))
  for (const filename of assets) {
    for (const mode of ["dark", "light"] as const) {
      test(`${filename}: ${mode}`, async () => {
        const colors = resolveThemeJson(await Bun.file(join(import.meta.dir, "assets", filename)).json(), mode)
        expect(Object.keys(colors).sort()).toEqual([...keys].sort())
        for (const key of keys) expect(colors[key]).toBeInstanceOf(RGBA)
      })
    }
  }
})

const userTheme = Bun.file(join(homedir(), ".config/opencode/themes/monokai-pro-ristretto.json"))
test.skipIf(!(await userTheme.exists()))("user's V2 ristretto colors", async () => {
  const colors = resolveThemeJson(await userTheme.json(), "dark")
  expect(colors.primary.equals(RGBA.fromHex("#a4cff9"))).toBe(true)
  expect(colors.background.equals(RGBA.fromHex("#2c2525"))).toBe(true)
  expect(colors.text.equals(RGBA.fromHex("#f1e3e5"))).toBe(true)
  expect(colors.accent.equals(RGBA.fromHex("#ffa5b1"))).toBe(true)
  expect(colors.backgroundPanel.equals(ristretto.backgroundPanel)).toBe(true)
  expect(colors.backgroundElement.equals(ristretto.backgroundElement)).toBe(true)
  expect(colors.backgroundMenu.equals(ristretto.backgroundMenu)).toBe(true)
  for (const key of keys) expect(colors[key]).toBeInstanceOf(RGBA)
})

test("legacy definitions, variants, references, optional colors and opacity metadata", () => {
  const json = {
    defs: { blue: { dark: "#123456", light: "#abcdef" }, alias: "blue" },
    theme: { primary: "alias", accent: "primary", background: "transparent", thinkingOpacity: 0.4 },
  }
  const dark = resolveThemeJson(json, "dark")
  expect(dark.primary.equals(RGBA.fromHex("#123456"))).toBe(true)
  expect(dark.accent.equals(dark.primary)).toBe(true)
  expect(dark.selectedListItemText.equals(dark.background)).toBe(true)
  expect(dark.backgroundMenu.equals(dark.backgroundElement)).toBe(true)
  expect(dark.background.a).toBe(0)
  expect(Object.keys(dark).sort()).toEqual([...keys].sort())
  expect(resolveThemeJson(json, "light").primary.equals(RGBA.fromHex("#abcdef"))).toBe(true)
})

test("ANSI palette supports standard colors, the cube and grayscale", () => {
  for (const [index, hex] of [[0, "#000000"], [15, "#ffffff"], [16, "#000000"], [196, "#ff0000"], [231, "#ffffff"], [232, "#080808"], [255, "#eeeeee"]] as const) {
    expect(resolveThemeJson({ theme: { primary: index } }, "dark").primary.toInts()).toEqual(RGBA.fromHex(hex).toInts())
  }
  expect(() => resolveThemeJson({ theme: { primary: 256 } }, "dark")).toThrow()
})

test("V2 mode overrides merge with base, aliases resolve whole palettes, input stays unchanged", () => {
  const json = {
    base: {
      hue: { blue: { "200": "#123456", "400": "#abcdef" }, interactive: "$hue.blue", accent: "$hue.interactive" },
      text: { base: "$hue.accent.200", muted: "$text.base" },
      background: { base: "#111111", raised: { base: "#222222" } },
      "@dialog": { background: { base: "$background.raised.base" } },
    },
    dark: { text: { muted: "$hue.interactive.400" } },
    light: { hue: { blue: { "200": "#654321" } } },
  }
  const before = JSON.stringify(json)
  const dark = resolveThemeJson(json, "dark")
  expect(dark.primary.equals(RGBA.fromHex("#123456"))).toBe(true)
  expect(dark.textMuted.equals(RGBA.fromHex("#abcdef"))).toBe(true)
  expect(dark.backgroundMenu.equals(RGBA.fromHex("#222222"))).toBe(true)
  expect(resolveThemeJson(json, "light").text.equals(RGBA.fromHex("#654321"))).toBe(true)
  expect(JSON.stringify(json)).toBe(before)
})

test("V2 uses the available mode when only one is defined", () => {
  const json = { base: { text: { base: "$hue.neutral.200" } }, dark: { hue: { gray: { "200": "#123456" }, neutral: "$hue.gray" } } }
  expect(resolveThemeJson(json, "light").text.equals(RGBA.fromHex("#123456"))).toBe(true)
  expect(resolveThemeJson(json, "light").background.equals(resolveThemeJson(json, "dark").background)).toBe(true)
})

test("missing colors derive from the theme, not ristretto", () => {
  const colors = resolveThemeJson({ theme: { text: "#123456", primary: "#654321", success: "#00ff00", error: "#ff0000" } }, "light")
  expect(colors.markdownText.equals(colors.text)).toBe(true)
  expect(colors.markdownLink.equals(colors.primary)).toBe(true)
  expect(colors.diffAdded.equals(colors.success)).toBe(true)
  expect(colors.diffRemoved.equals(colors.error)).toBe(true)
  expect(colors.background.equals(RGBA.fromHex("#ffffff"))).toBe(true)
  for (const key of keys) expect(colors[key]).toBeInstanceOf(RGBA)
})

test("rejects invalid theme shapes, colors, missing references and cycles", () => {
  for (const json of [null, [], {}, { base: {} }, { theme: { primary: "#nothex" } }, { theme: { text: "missing" } }]) {
    expect(() => resolveThemeJson(json, "dark")).toThrow()
  }
  expect(() => resolveThemeJson({ base: { text: { base: "$missing.token" } }, dark: {} }, "dark")).toThrow("not found")
  expect(() => resolveThemeJson({ defs: { a: "b", b: "a" }, theme: { primary: "a" } }, "dark")).toThrow("Circular")
  expect(() => resolveThemeJson({ base: { text: { base: "$text.muted", muted: "$text.base" } }, dark: {} }, "dark")).toThrow("Circular")
  expect(() => resolveThemeJson({ base: {}, dark: { hue: { interactive: "$hue.accent", accent: "$hue.interactive" } } }, "dark")).toThrow("Circular")
})

test("listing is sorted and load rejects unknown names", async () => {
  const themes = await listThemes()
  expect(themes.map((theme) => theme.name)).toEqual(themes.map((theme) => theme.name).sort((a, b) => a.localeCompare(b)))
  expect(new Set(themes.map((theme) => theme.name)).size).toBe(themes.length)
  await expect(loadTheme("../not-a-theme", "dark")).rejects.toThrow("Unknown theme")
})

test("discovery applies builtin < opencode < pascode precedence, then loads by filename", async () => {
  const home = await mkdtemp(join(tmpdir(), "pascode-themes-"))
  try {
    for (const source of ["opencode", "pascode"]) {
      const directory = join(home, ".config", source, "themes")
      await mkdir(directory, { recursive: true })
      await Bun.write(join(directory, "opencode.json"), JSON.stringify({ theme: { primary: source === "pascode" ? "#123456" : "#654321" } }))
    }
    await Bun.write(join(home, ".config/opencode/themes/custom.json"), JSON.stringify({ theme: { primary: "#abcdef" } }))
    const script = `
      import { listThemes, loadTheme } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
      const themes = await listThemes();
      console.log(JSON.stringify({ themes, primary: (await loadTheme("opencode", "dark")).primary.toInts() }));
    `
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" })
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(error).toBe("")
    expect(exit).toBe(0)
    const result = JSON.parse(output)
    expect(result.themes).toHaveLength(34)
    expect(result.themes.find((theme: { name: string }) => theme.name === "opencode").source).toBe("pascode")
    expect(result.themes.find((theme: { name: string }) => theme.name === "custom").source).toBe("opencode")
    expect(result.primary).toEqual([18, 52, 86, 255])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
