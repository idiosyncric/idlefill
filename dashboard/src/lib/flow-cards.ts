// The flow view's card layer (#91): pure facts for the session cards, the
// engine cards, and the "outside idlefill" detection — no DOM, no fetch.
// Everything here reads the /api/state payload the view already has.
//
// Honesty law (the load-read precedent, carried verbatim): every field is
// either a PUBLISHED fact (gateway ledger counts, the engine's own status
// envelope) or ABSENT — never inferred, never a fake zero. The session→engine
// edge itself still lives in lib/session-edge.ts; this lib only decorates it.
//
// The "outside idlefill" rule: an engine row that NAMES an in-flight count
// (oMLX `active_requests`, strata's single live slot) can prove traffic the
// router never registered — conversations aimed straight at the engine
// instead of through a /s/<token> session. foreign = in_flight − the
// idlefill sessions the gate says are holding a slot on that engine RIGHT
// NOW. A parked (queued) request is NOT in-flight at the engine, so it never
// counts as a slot. Kinds with no in-flight axis (llama-swap, HTTP-only)
// simply never produce a row — no count, no claim.
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
  /** The engine's own in-flight count, verbatim. */
  inFlight: number;
  /** Idlefill sessions the gate says hold a slot on this engine right now. */
  idlefillSlots: number;
  /** inFlight − idlefillSlots — traffic the router never registered. */
  foreign: number;
};

/** Engines whose own status names MORE in-flight work than idlefill holds. */
export function foreignActivity(st: StateSnapshot, engines: ServerRow[]): ForeignRow[] {
  const out: ForeignRow[] = [];
  for (const e of engines) {
    const inFlight = num(e.signal?.in_flight);
    if (inFlight === null) continue; // the kind names no in-flight axis: no row, no claim
    const target = (s: SessionRow) => s.engine_pin?.server_id ?? s.server_id ?? "";
    let slots = 0;
    for (const s of st.sessions ?? []) {
      if (target(s) !== e.id) continue;
      if (s.gate?.state === "queued") continue; // parked at the client, not at the engine
      const active =
        s.gate?.state === "active" ||
        (s.gate == null && s.last_activity != null && st.now - s.last_activity < ACTIVE_WINDOW_MS);
      if (active) slots += 1;
    }
    if (inFlight > slots) out.push({ engineId: e.id, inFlight, idlefillSlots: slots, foreign: inFlight - slots });
  }
  return out;
}
