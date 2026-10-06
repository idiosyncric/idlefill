# Issue #65 brief (mirror of the Forgejo issue body)

## Symptom (live, 2026-10-06)

`hermes` profile on `custom:idlefill` (`http://127.0.0.1:8800/v1`) fails with: "Provider returned an empty stream with no finish_reason (possible upstream error or malformed SSE response)." Three retries, no answer.

Direct probe proves the router lies about the engine's status:

```
curl 127.0.0.1:8000/v1/chat/completions …   -> HTTP 401  {"error":{"message":"API key required",…}}
curl 127.0.0.1:8800/v1/chat/completions …   -> HTTP 200  {"error":{"message":"API key required",…}}
curl 127.0.0.1:11435/v1/chat/completions …  -> HTTP 200  {"error":{"message":"API key required",…}}
```

The engine answers **401**. Both listeners deliver the same body with status **200**. An OpenAI-compatible SDK sees 200, tries to parse a completion, finds no choices/SSE frames, and reports an empty stream. The real reason (auth rejected) never reaches the caller.

## Root cause (verified on disk)

`client/src/aggregate.ts:177-183` — the upstream response handler copies upstream HEADERS (`res.setHeader(k, v)`) then `up.pipe(res)`. It never copies `up.statusCode`. `res.statusCode` stays at the Node default 200.

`client/src/proxy.ts:97-106` — the 11435 passthrough has the identical shape: it records `entry.status = up.statusCode` for the request log, but never writes it to `res`. Same 200-wrap on all job traffic.

## Fix

Both forwarders: set `res.statusCode = up.statusCode ?? 502` before piping headers/body. Keep the existing posture everywhere else:

- the router's own 502 for an unreachable engine stays.
- the gate's 503 for parked-with-timeout stays.
- hop-by-hop header skipping stays.

## Tests

- upstream answers 401 -> the client sees 401. Cover the aggregate listener, the proxy passthrough, and the path through `gate.route` admission.
- upstream answers 200 SSE -> status stays 200, SSE frames byte-identical (the #45 sniffer tests already pin the frame stream).
- upstream unreachable -> 502 unchanged.

## Live acceptance

- With the oMLX row keyless (`srv-watched`, `auth_set: false` today): a chat-completions for `Qwen3.8-Flash-Next` through `:8800` returns **401**, body from the engine.
- `curl` the 11435 plain `/v1/chat/completions` passthrough -> 401 as well.
- `qwen3.8-flash-next-iq3_s` (row with a token) still streams fine end to end.

## Notes

- The immediate operator relief is separate: set the engine token on the `srv-watched` row (write-only field, Settings/Servers). This issue fixes the **status lie**, not the key.
- D6 fence: the 11435 contract is "headers pass through" — the status was always meant to pass too (the code already captures it into `entry.status`). This restores intended fidelity, it is not a contract change. Job adapters that mis-retried on 200+error bodies get correct 4xx instead.
