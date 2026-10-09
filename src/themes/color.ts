// Ported from OpenCode v2.0.26 (MIT), packages/theme/src/tui/color.ts.
import { RGBA } from "@opentui/core"

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  return RGBA.fromInts(
    Math.round((base.r + (overlay.r - base.r) * alpha) * 255),
    Math.round((base.g + (overlay.g - base.g) * alpha) * 255),
    Math.round((base.b + (overlay.b - base.b) * alpha) * 255),
  )
}
