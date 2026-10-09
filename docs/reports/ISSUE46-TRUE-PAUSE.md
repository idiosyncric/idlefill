# Issue #46 — true pause: what shipped, and what is blocked

Map: #42 (the middleware plugin, the native path for an in-session signal) · #44 (queue transparency) · #45 (session detail) · #31 (where the hold happens) · #29 (the gateway control socket has no per-session verb, verified).

## The gap

A parked request has no in-session feedback. Inside Hermes the session looks like it is thinking. Pause feels like a hang.

## Shipped (main `e0025cc`, bundle rebuild `c822b3f`)

**1. The hold is observable.** `SessionGate.snapshot()` carries `waitSince`, the instant the park began, while a session is queued. It is the router's clock, verbatim, following the `phase.at` precedent. A park transition registers with the arbiter on the `0 → 1` transition only, following the #67 right-away precedent. The Sessions row renders the hold and its age.

**2. The hold can be released.** `client/src/session-control.ts` adds `POST /sessions/<token>/release` on the loopback daemon. It answers every parked request for that token with the retryable 503 + `Retry-After` the hold-cap contract already defines, and frees the queue slot.

The guard is the exact posture `client-projects.ts` uses:
- Host: `127.0.0.1` or `localhost` only. This closes DNS-rebinding Host games.
- Origin: a request that carries an Origin must come from a loopback origin. A non-browser client with no Origin is allowed.
- Auth: `X-Idlefill-Edit: <arbiter token>`, constant-time compare against the token this client already holds. A client with no token configured gets 401. An empty header never matches an empty config.

Unknown token, or no parked holds, returns `{ ok: true, released: 0 }`. Idempotent. Never an error, because the operator may call it after the turn already settled.

## What is NOT built, and why

`releaseHold` releases the hold. It does not interrupt traffic already in flight, and it does not clear the operator pause override. Those limits are stated on the method itself.

A true "stop thinking" needs a Hermes-side verb. Two facts, both verified:

- The gateway control socket has no per-session stop verb (#29).
- The `llm_execution` middleware can block before `next_call` with no timeout. That is the hold point, and it is also why a plugin there must never throw.

So the honest version available today is: the parked turn stops stalling, the agent sees the 503, and the turn ends on the agent's side rather than hanging. That is a real improvement over a silent stall. It is not an interrupt.

The in-session text "held by idlefill gate (Ns)" requires either the #42 plugin path, or a Hermes notification/observer hook for the router path. #42 is the seam. It is still in flight.

## Tests

`client/test/session-control.test.ts` (390 lines, real sockets): release releases the hold, an unknown token is a no-op, the auth posture rejects a wrong token and a non-loopback Origin, and the gate behaves exactly as before when the feature is off.

`client/test/session-gate.test.ts` +15 lines for the `waitSince` snapshot key.

Actual output at HEAD `c822b3f`: server 257/257, client 159/159, 17/17, 2/2, 0 failures. Build green.
