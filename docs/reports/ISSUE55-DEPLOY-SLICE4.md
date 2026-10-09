# Issue #55 — Fleet service, slice 4: deployment plane

Slice 4 is the deployment plane. It adds templates, docs, and a health
check. It builds no service code. It does not push. It does not deploy.

## What was built

- `docs/architecture/fleet-deployment.md` — where the service runs
  (urza, D7), how it is reached (tailnet only), how it starts, how it
  restarts, how the SQLite file is backed up, what the operator must
  provision. Every decision value is marked PROPOSED.
- `fleet/deploy/fleetlink.service.template` — systemd user unit
  (Linux, urza). Mirrors `deploy/systemd/idlefill-client.service.template`.
- `fleet/deploy/com.sam.idlefill.fleet.plist` — LaunchAgent (macOS).
  Mirrors `deploy/com.sam.idlefill.server.plist`.
- `fleet/deploy/config.example.json` — the three config keys, placeholder
  values only. No secret, no live db path.
- `fleet/deploy/health.sh` — a reachability probe (no key needed).
- `fleet/deploy/README.md` — how to copy the templates onto the host and
  what to replace.
- This report and one index line in `docs/reports/README.md`.

## Decisions honored

- D7 LOCKED: urza host, tailnet-only reach, `fleet.samwarth.com`,
  dependency-free Node, no published port.
- D6 LOCKED: SQLite as a file. The backup is a file copy.
- The existing repo deploy pattern is matched (a systemd user-unit
  template for Linux and a LaunchAgent plist for macOS, both `npx tsx`
  from a working-tree checkout, on-failure restart, 30 s throttle). No
  new pattern was invented.
- No committed file holds a real token, key, credential, or live db
  path. The committed templates hold placeholders only.
- Pairing (D4) is not implemented. No enrollment token is created in a
  committed file.

## Verification (run for real)

- `bash -n fleet/deploy/health.sh`: clean.
- `NODE_ENV=test npm run test` from the root (all workspaces): all pass.
- `NODE_ENV=test npx tsx fleet/src/index.ts` boots the service. A real
  local `curl GET /roster` returns the 401 JSON error envelope.
- `fleet/deploy/health.sh` against the started service returns OK.

## Open owner decisions (not settled here)

- Pairing (D4): shape (a) or (b), and the edge directionality. Nothing
  pairing-related is built.
- The three PROPOSED D3 cadence values: heartbeat 60 s, the
  control-action staleness ceiling 24 h, and the roster pull 15 s. The
  service locks no value.
