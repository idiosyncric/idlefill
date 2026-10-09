# ISSUE39-ENFORCEMENT-ACCEPTANCE — the #39 enforcement half, acceptance-gated

**Finding first:** the enforcement plane is ALREADY SHIPPED on `main` (slice 1
`f6a460e`, slice 2 `cb63b25` + merge `81f3a3c`; the pairing ceremony, #55
slice 6 `0762372`). This slice does NOT rebuild it. It closes the issue's
enforcement half by (a) pinning the acceptance list as real-crypto tests and
(b) proving it live against the real entry — and by recording, with
file:line, exactly what pairing.md mandates for a paired request's auth.

## Auth of a paired request — as pairing.md says it (no invention)

- pairing.md:58-63 (D1): **asymmetric per-edge credential** — the requester
  signs with its own ed25519 private key (the #55 D1 substrate,
  `identity.json`, 0600); the target verifies against the peer's PUBLIC key
  stored in the LOCAL edge record for that `instance_id`. The edge record
  carries a public key, never a shared secret.
- pairing.md:313-317 (wire keys): the auth hook "gains a per-edge signature
  check" — it verifies "the requester's ed25519 signature against the stored
  peer public key for that `instance_id`"; the `peer_token` plane and the
  `api_tokens` plane stay unchanged.
- pairing.md:297-301: the routes ride the per-edge credential
  (`controls_me`); D5 (pairing.md:211-219): the target admits the request
  only when its edge record for the requester is `controls_me`.
- Wire shape (shipped substrate): a signed canonical payload
  `{ instance_id, path, ts, nonce }` (server/src/edges.ts:96-109) presented
  as headers `X-Idlefill-Instance-Id` / `-Signature` / `-Nonce` / `-Ts`
  (server/src/api.ts:351-361). Verification: server/src/edges.ts
  `verifyRequester` (138-158) → `Identity.verify` (identity.ts:157).
  Every denial is NAMED (D8): `unknown_instance_id` / `bad_signature` /
  `missing_instance_id`, plus the slice-2 `stale_ts` / `nonce_replayed`.
- Verdict: **implementable with the shipped substrate** — the #55 D1
  keypair (identity.ts), the EdgeStore (edges.ts), and the ceremony
  (fleet slice 6) all exist on `main`; no missing primitive was needed.

## What this slice added

- `server/test/mesh-enforcement-slice2.test.ts` — 11 acceptance tests
  (real ed25519, real Fastify on loopback, no mocks): no edge → 403 named on
  BOTH routes; a `controls_me` edge allows the detail read (job ids + titles
  cross); a relayed verb changes ONLY the target's own rows (the other
  client + both session rows untouched, D7 audit carries `source_instance_id`);
  an unknown verb is 400 `bad_action` (no change, no audit); the detail
  projection is payload-free (stored `client_log` tail and a real lease id
  never appear; the body is exactly the D3 keys); path binding (a
  /control-preview signature is `bad_signature` on /control); the coarse
  plane stays coarse.
- `issue39-live-proof.mjs` — drives the REAL `server/src/index.ts` entry on a
  scratch loopback port (:8791, NOT the running :8787) with a temp state
  file and a seeded `mesh_edges.json` (real minted public key): unpaired
  signature → 403 `unknown_instance_id` on both routes; paired → detail 200
  with the queue preview, `pause` applied (visible on `/api/state`), `steal`
  → 400 `bad_action`, detail payload-free (no raw log lines), coarse plane
  without job ids. The scratch process is stopped + its temp dir removed.

## Gates (branch `issue-39-detail`, from main `6efdc32`)

`NODE_ENV=test npm run test` — server **379/379** (368 shipped + 11 new),
client 177, career-ops 17, noop 2, shell-ui 3, dashboard 4, fleet 30 — 0 fail.
`NODE_ENV=test npx tsc --noEmit -p server/tsconfig.json` — exit 0.
