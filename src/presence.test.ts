import { expect, test } from "bun:test"
import { createPresence, routeAttention } from "./presence"

test("routing: the daemon's pick alerts; a counted client's silence is final; an uncounted one falls back to sessions it opened", () => {
  const route = (shouldNotify: boolean, present: boolean, watched: boolean) => routeAttention({ shouldNotify, present, watched })
  expect(route(true, true, false)).toBe("now")
  expect(route(true, false, false)).toBe("now")
  expect(route(false, true, true)).toBe("no") // counted and not picked: another client has it, or someone is watching
  expect(route(false, false, true)).toBe("unacknowledged")
  expect(route(false, false, false)).toBe("no")
})

test("present for 150 s after the last real input, which a heartbeat doesn't extend", () => {
  let at = 1_000_000
  const sent: string[] = []
  const presence = createPresence((beat) => sent.push(beat.lastActivityAt), () => at)
  expect(presence.present()).toBe(true)
  at += 150_000
  expect(presence.present()).toBe(true)
  presence.beat()
  at += 1
  expect(presence.present()).toBe(false)
  expect(sent).toEqual([new Date(1_000_000).toISOString()]) // the beat reported launch time, not "now"
  presence.active()
  expect(presence.present()).toBe(true)
})
