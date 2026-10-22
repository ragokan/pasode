// The host's policy for attention events (src/presence.ts), which a plugin can't import at runtime; warp.test.ts checks
// the two agree. The daemon picks one recipient (`shouldNotify`) from the clients' heartbeats and is silent for everyone
// while a visible client is focused on the session. That only means something for a client it counted (`present`); an
// idle one can't tell "someone is watching it" from "nobody is here", so it alerts only for sessions opened here that
// nobody acknowledges within ACK_MS (the Paseo apps clear the flag when you view the session).
export const ACK_MS = 3_000
/** The daemon counts a client present for 180 s after its last activity; shave a margin for clock skew and late beats. */
export const PRESENT_MS = 150_000

export function routeAttention({ shouldNotify, present, watched }: { shouldNotify: boolean; present: boolean; watched: boolean }) {
  if (shouldNotify) return "now"
  return !present && watched ? "unacknowledged" : "no"
}
