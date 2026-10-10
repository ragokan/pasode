// Provenance: ~/coding/ocode/plugins/ocode/tui.ts; adapted to Paseo's array plugin loader.
import context from "./sidebar-context/tui"
import mcp from "./sidebar-mcp/tui"
import todo from "./sidebar-todo/tui"
import files from "./sidebar-files/tui"
import usage from "./usage-sidebar/tui"
import metrics from "./token-metrics/tui"
import footer from "./sidebar-footer/tui"
import warp from "./warp/tui"
import type { PasodePlugin } from "@pasode/host"

export default [context, mcp, todo, files, usage, metrics, footer, warp] satisfies PasodePlugin[]
