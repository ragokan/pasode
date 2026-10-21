import { afterEach, expect, spyOn, test } from "bun:test"
import { api, daemon, refreshUsage, setUsage, usage } from "../paseo"

afterEach(() => setUsage(undefined))

const report = (id: string) => ({ id, sourceId: id, sourceLabel: id, account: {}, fetchedAt: "2026-10-21T00:00:00.000Z", report: { status: "available" as const, windows: [] } })

test("refreshUsage reads usage reports when the host has them and keeps the last ones when a refresh fails", async () => {
  const info = spyOn(daemon, "getLastServerInfoMessage").mockReturnValue({ features: { usageSources: true } } as never)
  const reports = spyOn(daemon, "listUsageReports").mockResolvedValueOnce({ requestId: "r", reports: [report("claude")] }).mockRejectedValueOnce(new Error("offline"))
  const legacy = spyOn(api.providers, "listUsage")
  await refreshUsage()
  expect(usage()?.map((entry) => entry.id)).toEqual(["claude"])
  await refreshUsage()
  expect(usage()?.map((entry) => entry.id)).toEqual(["claude"])
  expect(legacy).not.toHaveBeenCalled()
  for (const mock of [info, reports, legacy]) mock.mockRestore()
})

test("hosts without usage reports keep the provider list, presented as reports", async () => {
  const info = spyOn(daemon, "getLastServerInfoMessage").mockReturnValue({ features: {} } as never)
  const reports = spyOn(daemon, "listUsageReports")
  const legacy = spyOn(api.providers, "listUsage").mockResolvedValue({
    requestId: "r",
    fetchedAt: "2026-10-21T00:00:00.000Z",
    providers: [
      { providerId: "claude", displayName: "Claude", status: "available", planLabel: "Max", windows: [{ id: "5h", label: "5h", usedPct: 10 }] },
      { providerId: "codex", displayName: "Codex", status: "error", planLabel: null, windows: [], error: "login expired" },
    ],
  } as never)
  await refreshUsage()
  expect(reports).not.toHaveBeenCalled()
  expect(usage()?.map((entry) => [entry.sourceId, entry.report.status])).toEqual([["claude", "available"], ["codex", "error"]])
  expect(usage()?.[0]?.report).toMatchObject({ status: "available", planLabel: "Max", windows: [{ id: "5h", usedPct: 10 }] })
  for (const mock of [info, reports, legacy]) mock.mockRestore()
})
