import { registerCommands } from "../commands"
import { current } from "../state"
import { openProfiles } from "./profiles"
import { createSchedule, openSchedules } from "./schedules"
import { openScripts } from "./scripts"

export { configSummary, statusDialog } from "./status"

/** Workspace scripts, schedules/heartbeats and agent profiles; called once from App next to the built-in commands. */
export function registerManageCommands() {
  return registerCommands([
    { id: "scripts.list", title: "Workspace scripts", category: "Workspace", keybind: "<leader>w", slash: "scripts", enabled: () => !!current()?.workspaceId, run: openScripts },
    { id: "schedules.list", title: "Schedules & heartbeats", category: "Workspace", slash: "schedules", run: openSchedules },
    { id: "schedules.heartbeat", title: "Heartbeat this session", category: "Workspace", slash: "heartbeat", enabled: () => !!current(), run: () => void createSchedule("heartbeat") },
    { id: "profiles.list", title: "Agent profiles", category: "Agent", slash: "profiles", run: openProfiles },
  ])
}
