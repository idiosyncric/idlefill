// The flow view's card layer (#91): pure facts for the session cards, the
// engine cards, and the "outside idlefill" detection — no DOM, no fetch.
// Everything here reads the /api/state payload the view already has.
//
// Honesty law (the load-read precedent, carried verbatim): every field is
// either a PUBLISHED fact (gateway ledger counts, the engine's own status
// envelope) or ABSENT — never inferred, never a fake zero. The session→engine
// edge itself still lives in lib/session-edge.ts; this lib only decorates it.
//
// The "outside idlefill" rule, two-tier:
//  1. CONVERSATION evidence (strata): the engine NAMES the conversation KV
//     caches it parks between requests (`conversation_cache.parked`). Each
//     parked cache is a conversation the engine served; the live slot adds
//     the one conversation currently generating. Registered sessions account
//     for at most one conversation each (the captured hermes session id) —
//     the remainder is conversations the router never registered. An honest
//     CEILING on what's accounted for: a session whose cache was evicted is
//     invisible to the engine's count, so the remainder may under-claim.
//  2. REQUEST evidence (fallback, oMLX `active_requests`, strata's live
//     slot): foreign = in_flight − the idlefill sessions the gate says are
//     holding a slot RIGHT NOW. A parked (queued) request is NOT in-flight
//     at the engine, so it never counts as a slot. Kinds with neither axis
//     (llama-swap, HTTP-only) simply never produce a row — no count, no
//     claim.
import type { ServerRow, ServerSignal, SessionRow, StateSnapshot } from "./api";

// The same "active now" window the state word uses (lib/format.ts): a row
// without a gate block (old router) is treated as holding a slot only when
// the router saw a request on it inside this window.
const ACTIVE_WINDOW_MS = 30_000;

export type SessionCardFacts = {
  /** Agent profile that owns the session (provenance stamp) — null = never reported. */
  profile: string | null;
  /** Seconds the arbiter has known this session (since its first request). */
  ageS: number;
  /** Ctx = the input-token count the gateway ledger recorded for this session. */
  ctx: number | null;
  /** Turns = the message count the gateway ledger recorded. */
  turns: number | null;
  /** Engine-reported average decode rate (tokens/s) — the engine's own number. */
  genTps: number | null;
  /** Engine-reported average prompt-eval (prefill) rate (tokens/s). */
  prefillTps: number | null;
  /** Engine-reported KV-cache hit ratio as a whole percent (0–100). */
  cachePct: number | null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export function sessionCardFacts(
  s: SessionRow,
  engineSignal: ServerSignal | null,
  now: number,
): SessionCardFacts {
  const meta = s.hermes_meta ?? {};
  const ratio = num(engineSignal?.cache_efficiency);
  return {
    profile: typeof meta.profile === "string" && meta.profile !== "" ? meta.profile : null,
    ageS: Math.max(0, Math.floor(((now - (s.registered_at ?? now)) / 1000))),
    ctx: num(meta.input_tokens),
    turns: num(meta.message_count),
    genTps: num(engineSignal?.avg_generation_tps),
    prefillTps: num(engineSignal?.avg_prefill_tps),
    cachePct: ratio !== null && ratio <= 1 ? Math.round(ratio * 100) : null,
  };
}

export type ForeignRow = {
  engineId: string;
  /** Which of the engine's own counts produced this row. */
  evidence: "conversation_cache" | "in_flight";
  /** Conversation caches the engine says are PARKED (null = no such axis). */
  parkedConversations: number | null;
  /** The engine's own in-flight count, verbatim (null = no such axis). */
  inFlight: number | null;
  /** Conversation caches this view can attribute to registered sessions. */
  attributed: number;
  /** The remainder — conversations/traffic the router never registered. */
  foreign: number;
};

/** Sessions whose conversations live on this engine: registered AND actually
 *  used (a token that never sent a request has no conversation anywhere). */
function sessionsOn(st: StateSnapshot, engineId: string): SessionRow[] {
  return (st.sessions ?? []).filter(
    (s) =>
      (s.engine_pin?.server_id ?? s.server_id ?? "") === engineId &&
      ((s.history?.rpm ?? []).some((v) => v > 0) || s.last_activity != null || s.gate?.state === "queued"),
  );
}

/** Engines whose own conversation/request counts exceed what idlefill can
 *  account for. Conversation evidence wins when the engine names parked
 *  caches (strata); in-flight counts are the fallback (oMLX). */
export function foreignActivity(st: StateSnapshot, engines: ServerRow[]): ForeignRow[] {
  const out: ForeignRow[] = [];
  for (const e of engines) {
    const parked = num(e.signal?.conv_cache_parked);
    const inFlight = num(e.signal?.in_flight);
    if (parked === null && inFlight === null) continue; // no axis, no claim
    const mine = sessionsOn(st, e.id).length;
    if (parked !== null) {
      const foreign = parked - mine;
      if (foreign > 0) out.push({ engineId: e.id, evidence: "conversation_cache", parkedConversations: parked, inFlight, attributed: mine, foreign });
    } else if (inFlight !== null) {
      let slots = 0;
      for (const s of st.sessions ?? []) {
        if ((s.engine_pin?.server_id ?? s.server_id ?? "") !== e.id) continue;
        if (s.gate?.state === "queued") continue; // parked at the client, not at the engine
        const active =
          s.gate?.state === "active" ||
          (s.gate == null && s.last_activity != null && st.now - s.last_activity < ACTIVE_WINDOW_MS);
        if (active) slots += 1;
      }
      if (inFlight > slots) out.push({ engineId: e.id, evidence: "in_flight", parkedConversations: null, inFlight, attributed: slots, foreign: inFlight - slots });
    }
  }
  return out;
}
