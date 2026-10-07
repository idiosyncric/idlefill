# Issue #72 — Add-agent flow (dashboard) report

The #68 server plane (mint/revoke routes, digest enforcement at :8800)
shipped with static Agents-subview markup only; the dashboard never wired
it. This issue built the client flow in `server/public/index.html`. ZERO
server changes — the frozen #68 routes carry zero diff.

## 1. What was built (`server/public/index.html` only)

- **Agents sub-tab activated.** `RES_TABS` / `RES_TAB_IDS` / `RES_EMPTY_MSG`
  gained `agents` (the `#rtab-agents` button existed since #61 but was dead
  weight — it now switches the subview), and `#agents` joined the deep-link
  pair (`HASH_RES_RE` / `HASH_RES_MAP`): `/#agents` opens the sub-view.
- **The modal.** `#add-agent` opens an overlay dialog (`#add-agent-form`
  kept as the id, rebuilt as `.modal-backdrop` + `.modal` static DOM
  outside `<main>` — NOT the inline settings-form family). One label field
  (required, `maxlength=64` — the server's bound) + a machine select fed
  from `GET /api/agent-endpoints?token=` (exactly one endpoint →
  preselected; the modal states plainly that the URLs are loopback and an
  agent on another machine needs that machine's own dashboard) + "Mint
  key". Esc (window keydown) and a backdrop click close it. No token field
  anywhere in the modal (the write credential stays in the header gate
  field; the modal even says so when no token is stored). The near-black
  palette makes a dim-only backdrop weak, so the dialog carries a shadow.
- **One-time hand-off block.** On a successful mint the modal body swaps
  to a paste-ready block carrying the EXACT Hermes config.yaml shape
  (`model:` / `provider: custom` / `base_url: <selected machine url>` /
  `api_key: <the minted plaintext>`). `copy config` copies the whole
  block, `copy key` copies just the key — both ride the existing
  `copyText` + `flashCopied` pair. The block states: shown ONCE — the
  arbiter keeps only the digest, it never comes back. The plaintext lives
  in exactly ONE client variable (`mintedOnce`) for the life of the block:
  never localStorage, never the rows cache/render, never a fetch; closing
  the modal nulls it and re-renders the rows list.
- **Rows + revoke.** `#client-keys` renders the real rows from
  `GET /api/client-keys`: label + id (`<code>`) + created age (`ago()`) +
  a two-step revoke (the servers cards' arm idiom: click arms
  `confirm?`, second click POSTs `/api/client-keys/revoke {id}`; the
  4 s disarm and the header-message error posture match `wireServerActions`).
  The empty state keeps the honest sentence ("no agent keys minted — the
  aggregate endpoint accepts any caller on this machine").
- **Refresh posture (the Models pane's authoring cadence, NOT the 5s live
  poll).** `refreshAgents()` fires on sub-tab open (`applyResTab`), on
  token-set (the gate-token change handler), and on its own 30 s timer.
  No token → the pane names the requirement ("paste the arbiter token…")
  and no agent GET/POST leaves the page (asserted in the harness). The
  30 s tick refreshes an open create-state modal's machine picks ONLY
  while the label is untouched (never wipes keystrokes; never re-renders
  the one-time block).
- **Credential map.** The `agents-section` comment says plainly which
  credential is which: header gate-token + hand-off pair = the CONTROL-API
  token (:8787 writes); a minted agent key = the AGENT-INFERENCE credential
  (:8800). Nothing merged or removed.

## 2. Test — `server/test/page-agents.test.ts` (registered in `server/package.json`)

Committed vm + stub-DOM behavior test (the #66 harness pattern, but in the
suite instead of scratch): extracts the REAL inline script from
`public/index.html`, boots it against stubbed `document`/`fetch`/
`localStorage`, and asserts: script boots clean (TDZ family); markup
carries the ids + `modal-backdrop`; the script references `add-agent`,
`add-agent-form`, `client-keys`, `/api/client-keys`,
`/api/agent-endpoints`, the revoke route, and the config-snippet shape
(`provider: custom` / `base_url:` / `api_key:` / `shown ONCE`); no token →
the pane names the requirement and ZERO agent requests leave the page;
token set → both authoring GETs carry it, the 30 s timer exists and
refreshAgents is NOT on the 5 s poll; the anonymous /api/state poll never
carries the token even when stored; the mint POSTs exactly `{label}` and
the block shows the exact four-line config with the minted plaintext;
`copy config` copied the WHOLE block and `copy key` copied just the key
(execCommand clipboard path); the plaintext rode NO fetch URL/body and NO
localStorage entry, and closing WIPES the block (rows re-render with
label + id + `1h 0m ago`, no plaintext); Esc closes; revoke is the
two-step arm posting exactly `{id}`, and revoking to empty restores the
honest OFF sentence.

The #68 server + client suites ran green untouched (byte-zero diff).

## 3. Gates (real output)

```
$ npm test            (root workspaces)
idlefill-server:  tests 207  pass 207  fail 0   (incl. test/page-agents.test.ts)
idlefill-client:  tests 128  pass 128  fail 0   (aggregate+aliases suites untouched)
career-ops:       tests  17  pass  17  fail 0
noop:             tests   2  pass   2  fail 0
TEST-EXIT=0                                     (354 total, 0 fail)

$ npm run build            BUILD-EXIT=0
$ npx tsc --noEmit -p server/tsconfig.json   TSC-SERVER-OK
$ npx tsc --noEmit -p client/tsconfig.json   TSC-CLIENT-OK
$ node --check <extracted inline script, 163,025 chars>   PAGE-SYNTAX-OK
```

## 4. Live acceptance (scratch stack ONLY — production :8787/:8800 NEVER)

Recipe per #66: scratch arbiter :18801 (`IDLEFILL_CONFIG` env JSON, state
copy 0600), scratch daemon (`IDLEFILL_CLIENT_CONFIG` env JSON:
`aggregate_port 18802`, `proxy_port 0` — :11435 never touched,
`llm_target` = scratch echo :18803, scratch credential, NOT the
production token). No launchd label installed, loaded, or kickstarted.
Dashboard opened in an Orca browser tab; token pasted into the header
field; all steps DOM-asserted, both modal states screenshotted.

```
md5-before client/config.json: 4df79869f00b12d1e642705406afdce8
PASS scratch arbiter on :18801
PASS scratch daemon aggregate on :18802
PASS scratch client registered | aggregate_port: 18802
PASS /api/agent-endpoints: [{'client': 'scratch-72', 'url': 'http://127.0.0.1:18802/v1'}]
PASS echo server row srv-04de2e71
PASS production :8787 answers BEFORE: 200
PASS production :8800 answers BEFORE: 200
DOM: #agents deep link opens the sub-view; no-token pane reads
  "paste the arbiter token into the header to list and revoke agent keys"
DOM: token pasted → honest empty sentence
DOM: modal opens (fixed inset-0 backdrop, z 100, label maxlength 64,
  single endpoint PRESELECTED "scratch-72 · http://127.0.0.1:18802/v1",
  remote-machine honesty note shown, ZERO token inputs in the modal)
DOM: mint → block shows model:/provider: custom/base_url:
  http://127.0.0.1:18802/v1/api_key: idlk_… once + copy config/copy
  key/done buttons + "shown ONCE" note
attempt 0: keyless GET :18802/v1/models -> 401
PASS unkeyed curl 401 (enforcement live)
PASS keyed curl 200
PASS /v1/models data: ['echo-model']
PASS wrong-key curl 401
PASS GET /api/client-keys rows: [('key-7743026d', 'acceptance-agent')] | token field present: False
PASS revoke accepted (key-7743026d)
attempt 5: post-revoke unkeyed GET /v1/models -> 200   (one 20 s daemon pull)
PASS post-revoke unkeyed curl 200 (plane OFF again)
UI cycle: mint → rows show "ui-revoke-cycle key-55181a33 · 7s ago"
  (no plaintext); arm → "confirm?" armed; confirm → server rows [],
  pane restores the honest OFF sentence, gate-msg "agent key revoked";
  after one daemon pull unkeyed GET :18802/v1/models -> 200
  PASS unkeyed curl 200 (plane OFF after UI revoke)
teardown: scratch ports 18801/18802/18803 all down; killed only recorded PIDs
production :8787 after: 200   production :8800 after: 200
md5-after client/config.json: 4df79869f00b12d1e642705406afdce8   (byte-identical)
```

The post-revoke plane-OFF lagged exactly one 20 s daemon pull (the
`/api/server-keys` cadence) — the daemon re-pulls the digest set, so an
empty set lands within one poll. That is #68's shipped behavior, stated
here so the timing is on the record.

Screenshots (the api_key line redacted — the one-time posture applies to
screenshots too):

- `ISSUE72-modal-create.png` — the create state (label + machine select)
- `ISSUE72-modal-handoff.png` — the one-time hand-off block

## 5. Frozen surfaces / degradations

- Server diff: zero (`server/src/**` untouched; `server/package.json`
  gained only the test-file registration).
- Client diff: zero.
- A production static-page browser tab serves a cached document (fastify
  static cache) — a hard reload picks up the new page. Not part of this
  issue.
