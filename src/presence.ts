// Reports this terminal's focus and open session to the daemon the way the Paseo app does (its client-activity-tracker),
// so the daemon's attention routing (computeNotificationPlan) can pick one recipient and stay quiet while you watch a session.
import type { daemon } from "./paseo"

export const HEARTBEAT_MS = 15_000
/** How long after an unacknowledged attention event a client that wasn't routed it still alerts. */
export const ACK_MS = 3_000
/** The daemon counts a client present for 180 s after its last activity; shave a margin so skew or a late beat can't make us think we are when it doesn't. */
export const PRESENT_MS = 150_000

type Beat = Parameters<typeof daemon.sendHeartbeat>[0]

export function createPresence(send: (beat: Beat) => void, now = () => Date.now()) {
  let activeAt = now()
  let changedAt = activeAt
  let visible = true
  let agent: string | null = null
  const iso = (at: number) => new Date(at).toISOString()
  const beat = () => send({ deviceType: "web", focusedAgentId: agent, focusedTerminalId: null, lastActivityAt: iso(activeAt), appVisible: visible, appVisibilityChangedAt: iso(changedAt) })
  return {
    beat,
    /** Real input only, never a heartbeat: an idle terminal has to stop looking present. */
    active() {
      activeAt = now()
    },
    present: () => now() - activeAt <= PRESENT_MS,
    setVisible(next: boolean) {
      if (next === visible) return
      visible = next
      changedAt = now()
      if (next) activeAt = changedAt // coming back is activity, leaving isn't
      beat()
    },
    setAgent(id: string | null) {
      if (id === agent) return
      agent = id
      activeAt = now()
      beat()
    },
  }
}

/**
 * What this client does with an attention event. `shouldNotify` is the daemon's pick of one recipient, and it is silent
 * for everyone while a visible client is focused on the session. That only means something if we were counted
 * (`present`): a client idle past the threshold is never picked, and silence then can't tell "someone is watching it"
 * from "nobody is here", so it alerts if the session is one we opened and nobody acknowledges it within ACK_MS.
 */
export function routeAttention({ shouldNotify, present, watched }: { shouldNotify: boolean; present: boolean; watched: boolean }) {
  if (shouldNotify) return "now"
  return !present && watched ? "unacknowledged" : "no"
}
