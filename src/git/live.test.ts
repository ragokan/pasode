import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { daemon } from "../paseo"
import { prOf, refreshPr, statusOf, useCheckoutDiff, useCheckoutStatus, watchStatus } from "./live"
import type { Status } from "./model"

type Observer = { snapshot(payload: unknown): void; update(message: unknown): void }
/** Stands in for the client's OwnedSubscription: the test plays the daemon through `observer`. */
function fakeSubscription() {
  const observers: Observer[] = []
  const release = mock(async () => {})
  const subscription = { subscriptionId: "s1", ready: Promise.resolve({}), subscribe: (observer: Observer) => (observers.push(observer), () => {}), release }
  return { subscription, release, observers, emit: (message: unknown) => observers.forEach((o) => o.update(message)), snapshot: (payload: unknown) => observers.forEach((o) => o.snapshot(payload)) }
}

const status = (cwd: string, over: Record<string, unknown> = {}) => ({ cwd, isGit: true, currentBranch: "main", isDirty: false, ...over }) as unknown as Status
const settle = () => Bun.sleep(0)

let events: ReturnType<typeof fakeSubscription>
let observeEvents: ReturnType<typeof spyOn>
let getCheckoutStatus: ReturnType<typeof spyOn>
let checkoutRefresh: ReturnType<typeof spyOn>
beforeEach(() => {
  events = fakeSubscription()
  observeEvents = spyOn(daemon, "observeEvents").mockImplementation(() => events.subscription as never)
  getCheckoutStatus = spyOn(daemon, "getCheckoutStatus").mockImplementation(async (cwd: string) => status(cwd))
  checkoutRefresh = spyOn(daemon, "checkoutRefresh").mockImplementation((async () => ({ success: true })) as never)
})
afterEach(() => {
  for (const spy of [observeEvents, getCheckoutStatus, checkoutRefresh]) spy.mockRestore()
})

test("watchStatus loads the status, applies pushed updates for watched directories only, and releases the stream with the last watcher", async () => {
  const stopA = watchStatus("/live/a")
  const stopA2 = watchStatus("/live/a")
  await settle()
  expect(observeEvents).toHaveBeenCalledTimes(1)
  expect(observeEvents.mock.calls[0]![0]).toEqual(["checkout_status_update"])
  expect(statusOf("/live/a")?.isDirty).toBe(false)

  events.emit({ type: "checkout_status_update", payload: { ...status("/live/a", { isDirty: true, currentBranch: "feat" }), subscriptionId: "s1", prStatus: { cwd: "/live/a", status: null, githubFeaturesEnabled: true } } })
  events.emit({ type: "checkout_status_update", payload: status("/live/other", { isDirty: true }) })
  expect(statusOf("/live/a")).toMatchObject({ isDirty: true, currentBranch: "feat" })
  expect((statusOf("/live/a") as Record<string, unknown>).prStatus).toBeUndefined()
  expect(prOf("/live/a")?.githubFeaturesEnabled).toBe(true)
  expect(statusOf("/live/other")).toBeUndefined()

  // A reconnect resubscribes; whatever changed meanwhile is read again.
  getCheckoutStatus.mockImplementation(async (cwd: string) => status(cwd, { currentBranch: "after-reconnect" }))
  events.snapshot({})
  await settle()
  expect(statusOf("/live/a")?.currentBranch).toBe("after-reconnect")

  stopA()
  expect(events.release).not.toHaveBeenCalled()
  stopA2()
  await settle()
  expect(events.release).toHaveBeenCalledTimes(1)
  expect(statusOf("/live/a")).toBeUndefined()
})

test("useCheckoutStatus follows the directory it is given and stops watching when its owner is disposed", async () => {
  const [cwd, setCwd] = createSignal<string | undefined>("/live/one")
  let read!: () => Status | undefined
  const dispose = createRoot((dispose) => ((read = useCheckoutStatus(cwd)), dispose))
  await settle()
  expect(read()?.cwd).toBe("/live/one")
  setCwd("/live/two")
  await settle()
  expect(read()?.cwd).toBe("/live/two")
  expect(statusOf("/live/one")).toBeUndefined()
  setCwd(undefined)
  expect(read()).toBeUndefined()
  dispose()
  await settle()
  // One subscription served both directories: switching didn't release it in between.
  expect(observeEvents).toHaveBeenCalledTimes(1)
  expect(events.release).toHaveBeenCalledTimes(1)
})

test("refreshPr stores the forge's answer for watched directories", async () => {
  const stop = watchStatus("/live/pr")
  const checkoutPrStatus = spyOn(daemon, "checkoutPrStatus").mockImplementation((async () => ({ cwd: "/live/pr", status: { title: "T", number: 4 }, githubFeaturesEnabled: true })) as never)
  await refreshPr("/live/pr")
  expect(prOf("/live/pr")?.status?.number).toBe(4)
  checkoutPrStatus.mockRestore()
  stop()
})

const diffFile = (path: string, additions = 1) => ({ path, isNew: false, isDeleted: false, additions, deletions: 0, hunks: [] })

test("useCheckoutDiff streams files, refreshes git state only when the change list changes, and releases on dispose", async () => {
  const diffs: ReturnType<typeof fakeSubscription>[] = []
  const observe = spyOn(daemon, "observeCheckoutDiff").mockImplementation(((_cwd: string, _compare: unknown) => (diffs.push(fakeSubscription()), diffs.at(-1)!.subscription)) as never)
  const [compare, setCompare] = createSignal<{ mode: "uncommitted" } | { mode: "base"; baseRef?: string }>({ mode: "uncommitted" })
  let state!: ReturnType<typeof useCheckoutDiff>
  const dispose = createRoot((dispose) => ((state = useCheckoutDiff(() => "/live/diff", compare)), dispose))
  await settle()
  expect(observe).toHaveBeenCalledWith("/live/diff", { mode: "uncommitted" })
  expect(state.loading).toBe(true)

  diffs[0]!.snapshot({ files: [diffFile("a.ts")], error: null })
  expect(state).toMatchObject({ loading: false, tooLarge: false })
  expect(state.files.map((file) => file.path)).toEqual(["a.ts"])

  // The same list again (e.g. the daemon's own refresh) must not trigger another refresh: that would feed itself.
  diffs[0]!.emit({ type: "checkout_diff_update", payload: { files: [diffFile("a.ts")], error: null } })
  await Bun.sleep(900)
  expect(checkoutRefresh).not.toHaveBeenCalled()

  diffs[0]!.emit({ type: "checkout_diff_update", payload: { files: [diffFile("a.ts"), diffFile("b.ts", 3)], error: null, diffTooLarge: true } })
  expect(state.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"])
  expect(state.tooLarge).toBe(true)
  await Bun.sleep(900)
  expect(checkoutRefresh).toHaveBeenCalledTimes(1)

  diffs[0]!.emit({ type: "something_else", payload: { files: [] } })
  expect(state.files).toHaveLength(2)

  // Another comparison replaces the subscription.
  setCompare({ mode: "base", baseRef: "main" })
  await settle()
  expect(diffs[0]!.release).toHaveBeenCalledTimes(1)
  expect(observe).toHaveBeenLastCalledWith("/live/diff", { mode: "base", baseRef: "main" })
  expect(state.loading).toBe(true)
  expect(state.files).toHaveLength(0)
  diffs[1]!.snapshot({ files: [], error: { code: "NOT_GIT_REPO", message: "Not a git repository" } })
  expect(state.error).toBe("Not a git repository")

  dispose()
  expect(diffs[1]!.release).toHaveBeenCalledTimes(1)
  observe.mockRestore()
})
