# Admission policy design — issue #46, slice 2 (queued versus paused)

Design, 2026-10-09, main HEAD 75e14f7. Slice 1 (the release verb) is merged:
docs/reports/ISSUE46-TRUE-PAUSE.md. The #47 admission classes are merged:
docs/reports/ISSUE47-ADMISSION-POLICY.md. Pairing locks D4, D5, D7, D8
(docs/architecture/pairing.md) bound the operator surface. No source file changed.

## The queued-versus-paused decision rule

A request is not admitted for one of two reasons. The gate checks them in this order:
1. PAUSED: the arbiter stores a pause override and the gate learns it. The session's
   requests park as holds even with free slots; the row stays queued in place.
   admitLoop skips a paused session regardless of its #47 rank (the operator hold
   wins over the class, the shipped #47 rule). Unpause releases the session; it takes
   the next free slot without queue-jumping.
2. QUEUED: no pause override. A free slot forwards now; otherwise the request parks
   and admitLoop ranks the parked sessions (knob ON: 0 = aged background, 1 =
   interactive, 2 = background, FIFO tiebreak; knob OFF: strict FIFO).

The two states are distinct on the wire and in the UI. The gate snapshot carries
waitSince (the park instant, slice 1) but not the reason. This design adds one ADD
key, hold_kind (values: queued, paused; absent = unset, existing deployments
byte-for-byte), so the Sessions row and the in-session signal can say why traffic
is held: no slot, rank behind, or operator pause.

Interaction with the #47 classes (shipped, unchanged): the class decides ORDER among
queued candidates; the pause is a GATE in front of the queue. A paused session has
no rank while paused. A pause does not count as queue wait: on unpause the session
re-enters with its class and a fresh waitStart anchor, so a paused background session
does not age into rank 0 on unpause (the operator hold never buys priority). Budget
demotion (admission only, never a hard stop) and the slot cap are untouched.

## What the operator can change

- Per-session pause, resume, force, clear: the existing override routes
  POST /api/sessions/:token/override and POST /api/clients/:ref/override. pause
  holds that session's traffic; force bypasses the slot cap.
- Release the holds for one token (slice 1, merged): POST /sessions/<token>/release
  on the loopback daemon. Parked requests get the retryable 503 plus Retry-After;
  the slot frees. Idempotent.
- The #47 client-config knobs (default OFF): session_priority, session_token_budget,
  session_aging_ms, session_interactive_window_ms. Plus session_hold_cap_ms (the
  park limit before the retryable 503, default 120s).
- The dashboard Sessions row: the state word (queued or paused), the age from
  waitSince, the cause from hold_kind, and one release affordance per row.
- Fences: pause never preempts an in-flight request and never changes a #47 rank.
  No destructive verbs in this slice.
- The mesh control plane (pairing.md D4) relays pause, resume, force, clear, and
  reorder from a paired controller. The target applies them to its own rows only and
  logs each relayed action with the requester's instance_id (D7). This design adds
  no control surface beyond that lock.

## OPEN DECISIONS

1. Does the hold cap (default 120s, then the retryable 503) apply to paused holds, or only to queued holds? Today both park under it.
2. Confirm the pause-period rule: a pause does not feed the #47 aging clock, and unpause re-anchors waitStart.
3. The in-session signal "held by idlefill gate (Ns)" needs the #42 plugin seam (in flight): which path ships it, the native plugin or a router observer hook?
4. Scope of the optional turn interrupt: fence it out of slice 2 (it needs a Hermes-side per-session stop verb; #29 verified the gateway socket has none), or wait on a Hermes verb?
5. Name and channel of the hold_kind ADD key (the gate snapshot and the register heartbeat)?
