// Provenance: ~/coding/ocode/plugins/ocode/tui.ts; adapted to Paseo's array plugin loader.
import usage from "./usage-sidebar/tui"
import warp from "./warp/tui"
import type { PasodePlugin } from "@pasode/host"

export default [usage, warp] satisfies PasodePlugin[]
