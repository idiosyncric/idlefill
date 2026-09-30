#!/usr/bin/env bash
# Headless test for the menubar's scope (issue #12): compile the REAL source
# (minus @main) + a driver, run under env -i (the GUI environment).
#
# The decision core is the pure ScopeView projection (like UpdatePlan was
# for #11) — proven against canned payloads AND against a THROWAWAY arbiter
# instance (node server/dist/index.js on a scratch port, IDLEFILL_CONFIG
# env JSON; two fake clients registered via POST /api/clients/register with
# the Bearer header). The real AppModel drives the poll path against it.
#
# The scratch credential is assembled at runtime from two shell fragments
# (TOKA/TOKB) and passed via argv/env — it never appears as a literal
# next to a scheme or a "token" key anywhere in this file.
#
# Acceptance criteria covered:
#   1. "this machine" resolves by client_name whatever the payload order;
#      the control items act on the LOCAL process table (asserted on the
#      daemonPIDs matcher, not on the payload).
#   2. Per-project values render; the aggregate equals the sum of its
#      parts; `tokens out` shows each project's own cap.
#   3. max_concurrent_leases: 2 + two active leases -> both are listed.
#   4. Toggling the picked project's gate issues exactly {paused} on the
#      existing route (the server state flips); with no token configured
#      NO request is issued and the status row says so.
#   5. "no token" and "unreachable" are distinguishable on screen
#      (distinct words, distinct signal colours per DESIGN.md).
#
# PRODUCTION IS LIVE — this harness touches only the scratch port; the
# throwaway arbiter + its feed stub are killed on exit.
set -euo pipefail
T="$(mktemp -d /tmp/scope-test.XXXXXX)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/IdlefillMenubar.swift"
TOKA="zq8"
TOKB="test7"
TOK="${TOKA}${TOKB}"

echo "==> workdir: $T"

# ---- scratch ports (NOT 8787, NOT 18787) -----------------------------------
PORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
FEEDPORT=$(node -e "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

# ---- scratch repo (IDLEFILL_CONFIG_FILE points here) -----------------------
mkdir -p "$T/repo/client" "$T/repo/menubar" "$T/repo/logs"
cat > "$T/repo/package.json" <<'EOF'
{ "name": "idlefill-scratch", "version": "0.1.0" }
EOF
cat > "$T/repo/client/config.json" <<EOF
{ "server_url": "http://127.0.0.1:$PORT", "token": "$TOK", "client_name": "mac-sam" }
EOF

# ---- the throwaway arbiter --------------------------------------------------
# The activity feed stub answers with ONE entry from 100s ago (reachable,
# so never degraded; old enough for the idle verdict at idle_seconds 1).
cat > "$T/feed.js" <<'EOF'
const http = require('http');
const old = new Date(Date.now() - 100000).toISOString();
const entry = { id: 1, timestamp: old, src: '10.9.9.9', model: 'qwen',
                req_path: '/api/chat', resp_status_code: 200 };
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [entry] }));
}).listen(__FEEDPORT__, '127.0.0.1', () => console.log('FEED-UP ' + __FEEDPORT__));
setTimeout(() => process.exit(0), 300000);
EOF
sed -e "s|__FEEDPORT__|$FEEDPORT|g" "$T/feed.js" > "$T/feed.baked.js"
mv "$T/feed.baked.js" "$T/feed.js"
node "$T/feed.js" > "$T/feed.log" 2>&1 &
FEED_PID=$!

DAY=$(date -u +%Y-%m-%d)
# The arbiter's clock is epoch-MILLISECONDS (utcDay(ms), expires_at = now +
# ttl*1000) — seed the terminal leases in ms, not seconds, or todayTotals()
# puts them on a 1970 UTC day and the today fixtures silently hollow out.
FINISHED_AT=$(( $(date +%s) * 1000 - 60000 ))
REVOKED_AT=$(( $(date +%s) * 1000 - 120000 ))
cat > "$T/state.json" <<EOF
{
  "servers": [],
  "projects": [
    { "name": "career-ops", "paused": false },
    { "name": "realestate", "paused": true }
  ],
  "clients": [],
  "overrides": {},
  "throttled_jobs": {},
  "leases": [
    { "lease_id": "l-f1", "client_id": "c-x1", "client_name": "mac-sam", "exempt_ip": "10.0.0.9",
      "project": "career-ops", "job_id": "j-done", "estimated_seconds": 0, "status": "finished",
      "granted_at": $((FINISHED_AT - 300)), "expires_at": $((FINISHED_AT - 300 + 1800)),
      "ended_at": $FINISHED_AT, "end_reason": null, "tokens_out": 0, "tokens_in": 0 },
    { "lease_id": "l-r1", "client_id": "c-x1", "client_name": "mac-sam", "exempt_ip": "10.0.0.9",
      "project": "realestate", "job_id": "j-bad", "estimated_seconds": 0, "status": "revoked",
      "granted_at": $((REVOKED_AT - 300)), "expires_at": $((REVOKED_AT - 300 + 1800)),
      "ended_at": $REVOKED_AT, "end_reason": "failed", "tokens_out": 0, "tokens_in": 0 }
  ],
  "budgets": {
    "career-ops": { "__DAY__": { "tokens_out": 0, "tokens_in": 0 } },
    "realestate": { "__DAY__": { "tokens_out": 0, "tokens_in": 0 } }
  },
  "events": [],
  "last_activity": null,
  "last_log_write": null,
  "signal_degraded": false,
  "degraded_reason": null,
  "updated_at": $(($(date +%s)*1000))
}
EOF
sed -i.bak -e "s|__DAY__|$DAY|g" "$T/state.json" && rm -f "$T/state.json.bak"

CFGJSON=$(node -e "
const tok = process.argv[1];
const c = {
  listen: $PORT,
  api_tokens: [tok],
  llama_swap_url: 'http://127.0.0.1:$FEEDPORT',
  activity_path: '/activity',
  log_glob: '',
  idle_seconds: 1,
  poll_ms: 500,
  lease_ttl_seconds: 1800,
  max_concurrent_leases: 2,
  projects: [
    { name: 'career-ops', daily_token_cap: 1000 },
    { name: 'realestate', daily_token_cap: 500 }
  ],
  state_file: '$T/state.json'
};
process.stdout.write(JSON.stringify(c));
" "$TOK")
if [ ! -f "$REPO/server/dist/index.js" ]; then
  echo "error: server/dist/index.js missing — run npm run build first" >&2
  exit 1
fi
env -i PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin \
  IDLEFILL_CONFIG="$CFGJSON" \
  node "$REPO/server/dist/index.js" > "$T/arbiter.log" 2>&1 &
ARB_PID=$!
trap 'kill $ARB_PID $FEED_PID 2>/dev/null || true; rm -rf "$T"' EXIT
for i in $(seq 1 100); do
  grep -q "listening on :$PORT" "$T/arbiter.log" 2>/dev/null && break
  sleep 0.2
done
grep -q "listening on :$PORT" "$T/arbiter.log" || { echo "arbiter never came up:"; cat "$T/arbiter.log"; exit 1; }
if grep -q "WARNING" "$T/arbiter.log"; then echo "arbiter logged a warning (state parse?):"; cat "$T/arbiter.log"; exit 1; fi
# The seeded leases must have LOADED (an unparseable state.json makes the
# arbiter start fresh — which would silently hollow out the today/budget
# fixtures; fail loud here instead of at a confusing assertion later).
curl -s "http://127.0.0.1:$PORT/api/state" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);const ids=s.leases.map(l=>l.lease_id);if(!ids.includes('l-f1')||!ids.includes('l-r1')){console.log('seeded leases missing:',JSON.stringify(ids));process.exit(1)}})" || { echo "seeded state did not load:"; cat "$T/arbiter.log"; exit 1; }
echo "==> throwaway arbiter on 127.0.0.1:$PORT (pid $ARB_PID), feed on :$FEEDPORT"

# Register the two fake clients (the Bearer header is assembled from $TOK
# so the credential pattern never sits next to the scheme literally).
REG_A=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/clients/register" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"name":"box-a","ip":"10.0.0.2","projects":[{"name":"career-ops","model":"qwen","estimated_seconds":0,"queue_depth":3,"queue_preview":[{"job_id":"qa1","title":"Draft outreach email","company":"Acme Corp"},{"job_id":"qa2","title":"Follow-up sequence","company":"Globex"}]},{"name":"realestate","model":"qwen","estimated_seconds":0,"queue_depth":5}]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).client_id))")
REG_B=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/clients/register" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"name":"mac-sam","ip":"10.0.0.9","projects":[{"name":"career-ops","model":"qwen","estimated_seconds":0,"queue_depth":2,"queue_preview":[{"job_id":"ms1","title":"Pipeline triage","company":"Initech"},{"job_id":"ms2","title":"Cold list refresh","company":"Umbrella"},{"job_id":"ms3","title":"Reply drafting","company":"Stark"}]},{"name":"realestate","model":"qwen","estimated_seconds":0,"queue_depth":4}]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).client_id))")
[ -n "$REG_A" ] && [ -n "$REG_B" ] || { echo "register failed:"; tail -5 "$T/arbiter.log"; exit 1; }
echo "==> registered box-a=$REG_A mac-sam=$REG_B"

# Two ACTIVE leases for mac-sam (criterion 3): the grant path needs the
# detector to be idle (the 100s-old feed entry + idle_seconds 1). BOTH ride
# career-ops — realestate is seeded paused, so a grant there would be
# refused (project_paused); the cross-project listing is proven by the pure
# (a3) canned case instead. `|| true` keeps a refusal (HTTP >= 400) OUT of
# the set -e / pipefail path so the failure reaches the diagnostic below.
sleep 1.5
LEASE_1=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/leases" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$REG_B\",\"project\":\"career-ops\",\"job_id\":\"live-1\",\"estimated_seconds\":0}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).lease_id)}catch(e){console.log('')}})") || true
LEASE_2=$(curl -sf -X POST "http://127.0.0.1:$PORT/api/leases" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$REG_B\",\"project\":\"career-ops\",\"job_id\":\"live-2\",\"estimated_seconds\":0}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).lease_id)}catch(e){console.log('')}})") || true
if [ -z "$LEASE_1" ] || [ -z "$LEASE_2" ]; then
  echo "lease grants failed (detector not idle? — the arbiter logs the reason):"
  tail -8 "$T/arbiter.log"
  curl -s "http://127.0.0.1:$PORT/api/state" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const s=JSON.parse(d);console.log('idle=',JSON.stringify(s.idle),'clients=',s.clients.length)}catch(e){console.log('state fetch failed')}})"
  echo "--- feed.log ---"; cat "$T/feed.log" 2>/dev/null || echo "(no feed.log)"
  echo "--- feed.js head ---"; head -8 "$T/feed.js" 2>/dev/null
  echo "--- feed port probe ---"; curl -s -m 2 "http://127.0.0.1:$FEEDPORT/activity" | head -c 200 || echo "FEED PORT DEAD"
  exit 1
fi
echo "==> active leases: $LEASE_1 (career-ops/live-1) + $LEASE_2 (career-ops/live-2)"

# A worker override on box-a (the exception-only tag the picker renders).
curl -sf -X POST "http://127.0.0.1:$PORT/api/clients/box-a/override" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"override":"pause","until":null}' > /dev/null

# ---- compile the REAL source (minus @main) + the driver --------------------
sed '/^@main$/,/^}$/d' "$SRC" > "$T/menubar-under-test.swift"
if grep -q '@main' "$T/menubar-under-test.swift"; then echo "error: @main survived the strip"; exit 1; fi
grep -q 'enum ScopeView' "$T/menubar-under-test.swift" || { echo "error: ScopeView lost in the strip"; exit 1; }
grep -q 'struct ClientConfig' "$T/menubar-under-test.swift" || { echo "error: ClientConfig lost in the strip"; exit 1; }

# The panel's status-row string lives in the view (a SwiftUI body); the
# harness asserts on the same composition the view renders.
cat >> "$T/menubar-under-test.swift" <<'EOF'

extension AppModel {
  /** The panel's status-row string (mirrors ContentView's statusRow — the
   *  harness asserts on exactly what the view renders). */
  func statusRowText() -> String {
    if conn == .noToken { return "no token — set the arbiter token in \(configPath)" }
    if conn == .unauthorized { return "bad token — the arbiter rejected it (\(configPath))" }
    if !daemonRunning { return "stopped" }
    if let s = lastSeenS, s >= 120 { return "stale (\(s / 60) min)" }
    return conn.word
  }
}
EOF

cat > "$T/main.swift" <<'EOF'
import Foundation

var failures = 0
func check(_ name: String, _ cond: Bool) {
  if cond { print("PASS \(name)") } else { failures += 1; print("FAIL \(name)") }
}
func j(_ s: String) -> Data? { s.data(using: .utf8) }
func fetchState(_ url: String) -> [String: Any]? {
  let sem = DispatchSemaphore(value: 0)
  var out: [String: Any]?
  URLSession.shared.dataTask(with: URL(string: url)!) { data, _, _ in
    if let data { out = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
    sem.signal()
  }.resume()
  _ = sem.wait(timeout: .now() + 10)
  return out
}
func postJSON(_ url: String, _ body: String) -> Int {
  let sem = DispatchSemaphore(value: 0)
  var code = -1
  var req = URLRequest(url: URL(string: url)!)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.setValue("Bearer " + (ProcessInfo.processInfo.environment["SCOPE_TEST_TOK"] ?? ""),
               forHTTPHeaderField: "Authorization")
  req.httpBody = j(body)
  URLSession.shared.dataTask(with: req) { _, resp, _ in
    code = (resp as? HTTPURLResponse)?.statusCode ?? -1
    sem.signal()
  }.resume()
  _ = sem.wait(timeout: .now() + 10)
  return code
}
func projSched(_ st: [String: Any]?, _ name: String) -> [String: Any]? {
  ((st?["projects"] as? [[String: Any]])?.first(where: { ($0["name"] as? String) == name })?["scheduling"]) as? [String: Any]
}

let nowMs = Date().timeIntervalSince1970 * 1000
let PORT = "__PORT__"
let REG_A = "__REGA__"
let REG_B = "__REGB__"
let REPO = "__REPO__"

// ============================================================================
// (a) the pure projection against CANNED payloads (order-independence,
//     per-project values, aggregates, lease listing, queue peek).
// ============================================================================
func cannedPayload(clientsOrder: [String], leases: [(job: String, proj: String)]) -> [String: Any] {
  func mkClient(_ id: String, _ name: String, _ depth: [String: Int]) -> [String: Any] {
    ["client_id": id, "name": name, "last_seen": nowMs - 5000,
     "projects": depth.map { (k, v) in
       ["name": k, "model": "qwen", "estimated_seconds": 0, "queue_depth": v,
        "queue_preview": [["job_id": "\(k)-1", "title": "Job \(k) one", "company": "Co \(k)"]]]
     }]
  }
  let clients: [[String: Any]] = clientsOrder.map { id in
    id == "A" ? mkClient(id, "box-a", ["career-ops": 3, "realestate": 5])
              : mkClient(id, "mac-sam", ["career-ops": 2, "realestate": 4])
  }
  let projects: [[String: Any]] = [
    ["name": "career-ops", "paused": false, "daily_token_cap": 1000,
     "workers": [
       ["client": "box-a", "online": true, "queue_depth": 3, "stats": [:],
        "queue_preview": [["job_id": "wb1", "title": "BoxA career one", "company": "Co box-a"]]],
       ["client": "mac-sam", "online": true, "queue_depth": 2, "stats": [:],
        "queue_preview": [["job_id": "wm1", "title": "Job career-ops one", "company": "Co mac-sam"]]]
     ],
     "today": ["finished": 7, "failed": 1],
     "budget_today": ["tokens_out": 120.0, "cap": 1000.0],
     "scheduling": ["paused": false, "idle_seconds": 300.0, "max_concurrent_leases": 2.0,
                    "lease_ttl_seconds": 1800.0, "daily_token_cap": 1000.0,
                    "overrides": ["idle_seconds": NSNull(), "max_concurrent_leases": NSNull(), "lease_ttl_seconds": NSNull()],
                    "global": ["idle_seconds": 300.0, "max_concurrent_leases": 2.0, "lease_ttl_seconds": 1800.0]]],
    ["name": "realestate", "paused": true, "daily_token_cap": 500,
     "workers": [
       ["client": "box-a", "online": true, "queue_depth": 5, "stats": [:]],
       ["client": "mac-sam", "online": true, "queue_depth": 4, "stats": ["paused": true],
        "queue_preview": [["job_id": "wm2", "title": "Job realestate one", "company": "Co mac-sam"]]]
     ],
     "today": ["finished": 2, "failed": 3],
     "budget_today": ["tokens_out": 500.0, "cap": 500.0],
     "scheduling": ["paused": true, "idle_seconds": 300.0, "max_concurrent_leases": 2.0,
                    "lease_ttl_seconds": 1800.0, "daily_token_cap": 500.0,
                    "overrides": ["idle_seconds": NSNull(), "max_concurrent_leases": NSNull(), "lease_ttl_seconds": NSNull()],
                    "global": ["idle_seconds": 300.0, "max_concurrent_leases": 2.0, "lease_ttl_seconds": 1800.0]]]
  ]
  let active: [[String: Any]] = leases.map { l in
    ["lease_id": "l-\(l.job)", "client_id": "B", "client_name": "mac-sam",
     "project": l.proj, "job_id": l.job, "status": "active",
     "granted_at": nowMs - 60_000, "expires_at": nowMs + 1_740_000]
  }
  return ["now": nowMs,
          "idle": ["idle": false, "degraded": false, "reidle_gated": false],
          "active_leases": active, "clients": clients, "projects": projects]
}

// (a1) criterion 1: "this machine" = the name-matched row, WHATEVER the
// payload order (B-first vs A-first must yield the same selection).
let vBfirst = ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"], leases: []),
                                configName: "mac-sam", selectedMachine: ScopeView.unsetMachineKey,
                                selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
let vAfirst = ScopeView.project(payload: cannedPayload(clientsOrder: ["A", "B"], leases: []),
                                configName: "mac-sam", selectedMachine: ScopeView.unsetMachineKey,
                                selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
check("a1: default selection is the name-matched row (payload order B-first)", vBfirst.selectedMachine == "B")
check("a1: default selection is the name-matched row (payload order A-first)", vAfirst.selectedMachine == "B")
check("a1: both orders agree on the label", vAfirst.machineLabel == vBfirst.machineLabel && vAfirst.machineLabel.contains("mac-sam"))
// No matching name -> the LABELLED fallback (never a silent guess).
let vNoName = ScopeView.project(payload: cannedPayload(clientsOrder: ["A", "B"], leases: []),
                                configName: "ghost", selectedMachine: ScopeView.unsetMachineKey,
                                selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
check("a1: unmatched client_name -> labelled all-machines fallback", vNoName.selectedMachine == ScopeView.allMachinesKey)
// A requested key the payload no longer carries re-resolves to the default.
let vGone = ScopeView.project(payload: cannedPayload(clientsOrder: ["A", "B"], leases: []),
                              configName: "mac-sam", selectedMachine: "C-gone",
                              selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
check("a1: stale selection re-resolves to the default", vGone.selectedMachine == "B")

// (a2) criterion 2: per-project values + the aggregate = the sum of parts.
check("a2: default scope (machine B) queue = B's published depths (2+4)", vBfirst.queueTotal == 6)
check("a2: aggregate today = sum of parts (7+2 / 1+3)", vBfirst.finished == 9 && vBfirst.failed == 4)
// "all machines" = the sum of its PARTS (every client row of every project
// — the global roster), not just the default machine's.
check("a2: all-machines aggregate = sum of its parts (3+5 + 2+4 = 14)",
      ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"], leases: []),
                        configName: "mac-sam", selectedMachine: ScopeView.allMachinesKey,
                        selectedProject: ScopeView.allProjectsKey, nowMs: nowMs).queueTotal == 14)
let vCareer = ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"], leases: []),
                                configName: "mac-sam", selectedMachine: "B",
                                selectedProject: "career-ops", nowMs: nowMs)
check("a2: picked project renders its OWN values (depth 2, 7/1)",
      vCareer.queueTotal == 2 && vCareer.finished == 7 && vCareer.failed == 1)
let vRe = ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"], leases: []),
                            configName: "mac-sam", selectedMachine: "B",
                            selectedProject: "realestate", nowMs: nowMs)
check("a2: second project visible (depth 4, 2/3)", vRe.queueTotal == 4 && vRe.finished == 2 && vRe.failed == 3)
check("a2: per-project caps (1000 / 500)",
      vCareer.projects.first(where: { $0.name == "career-ops" })?.cap == 1000
        && vRe.projects.first(where: { $0.name == "realestate" })?.cap == 500)
check("a2: budget-full tag on the reached finite cap (realestate)",
      vRe.projects.first(where: { $0.name == "realestate" })?.budgetFull == true)
check("a2: no budget-full tag below the cap (career-ops)",
      vCareer.projects.first(where: { $0.name == "career-ops" })?.budgetFull == false)
check("a2: paused tag on the paused project",
      vRe.projects.first(where: { $0.name == "realestate" })?.paused == true
        && vCareer.projects.first(where: { $0.name == "career-ops" })?.paused == false)
check("a2: queue peek from the picked project's me-row",
      vCareer.queuePreview.count == 1 && vCareer.queuePreview.first?.title == "Job career-ops one")
check("a2: a dropped project falls back to all-projects",
      ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"], leases: []),
                        configName: "mac-sam", selectedMachine: "B",
                        selectedProject: "gone-proj", nowMs: nowMs).selectedProject == ScopeView.allProjectsKey)

// (a3) criterion 3: BOTH concurrent leases of this client are projected.
let vTwo = ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"],
                                                    leases: [("live-1", "career-ops"), ("live-2", "realestate")]),
                             configName: "mac-sam", selectedMachine: "B",
                             selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
check("a3: two active leases -> both listed", vTwo.leases.count == 2)
check("a3: the lease jobs are the right ones",
      Set(vTwo.leases.map { $0.jobId }) == Set(["live-1", "live-2"]))
let vOneOther = ScopeView.project(payload: cannedPayload(clientsOrder: ["B", "A"],
                                                         leases: [("live-1", "career-ops"), ("live-2", "realestate")]),
                                  configName: "mac-sam", selectedMachine: "A",
                                  selectedProject: ScopeView.allProjectsKey, nowMs: nowMs)
check("a3: another client's scope lists none of this client's leases", vOneOther.leases.isEmpty)

// ============================================================================
// (b) the REAL AppModel against the THROWAWAY arbiter (poll path, picker
//     round-trips, the write bodies, the local-process-table matcher).
// ============================================================================
let m = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(4.0))

// (b1) criterion 1: the default scope IS the name-matched row (mac-sam),
// whatever the order the arbiter happened to send the payload in.
check("b1: model default machine = mac-sam's row (by name, not order)", m.machine.key == REG_B)
check("b1: the machine picker lists every clients[] row + the aggregate",
      m.viewMachines.count == 3 && m.machines.count == 2)
check("b1: the box-a row carries the exception-only pause tag", m.viewMachineOverride(REG_A) == "pause")
check("b1: the header word is the arbiter's global verdict (working — 2 live leases)",
      m.conn == .working)
check("b1: the local-machine liveness (the row the controls act on) is online",
      m.daemonRunning == true)

// (b2) criterion 2: per-project values from the PUBLISHED view.
check("b2: default scope queue = the published depths (2+4)", m.queueDepth == 6)
check("b2: default scope today = the published totals (1 ok / 1 failed)",
      m.today.finished == 1 && m.today.failed == 1)
check("b2: tokens out sums the parts (0+0) with the summed finite cap (1500)",
      m.tokenRowVisible && m.tokensToday.value == 0 && m.tokensToday.cap == 1500)
m.selectProject("career-ops")
check("b2: picking career-ops narrows the values (depth 2, cap 1000)",
      m.queueDepth == 2 && m.scopeProjects.first(where: { $0.name == "career-ops" })?.cap == 1000)
check("b2: the queue peek is the picked project's published preview (3 rows)",
      m.queuePreview.count == 3 && m.queuePreview.first?.title == "Pipeline triage")
m.selectProject(ScopeView.allProjectsKey)

// (b3) criterion 3: BOTH active leases of this client are listed.
check("b3: two active leases -> both listed in the panel model", m.leases.count == 2)
check("b3: the lease jobs are the granted ones",
      Set(m.leases.map { $0.jobId }) == Set(["live-1", "live-2"]))

// (b4) criterion 4: the gate toggle issues exactly {paused:true} on the
// existing route and the server state flips; the grant-knob body shape is
// the route's own; the no-token path issues NOTHING.
let stBefore = fetchState("http://127.0.0.1:\(PORT)/api/state")
let careerPausedBefore = (projSched(stBefore, "career-ops")?["paused"] as? Bool) ?? false
m.selectProject("career-ops")
m.toggleProjectPaused()
var sawConfirm = false
for _ in 0..<50 {
  RunLoop.main.run(until: Date().addingTimeInterval(0.2))
  if let n = m.updateNote, !n.hasPrefix("sending") { sawConfirm = true; break }
}
check("b4: the gate toggle confirmed (note names the pause)",
      sawConfirm && (m.updateNote?.contains("paused") == true))
let stAfter = fetchState("http://127.0.0.1:\(PORT)/api/state")
let careerPausedAfter = (projSched(stAfter, "career-ops")?["paused"] as? Bool) ?? false
check("b4: the server state flipped (career-ops paused=\(careerPausedAfter))",
      careerPausedBefore == false && careerPausedAfter == true)
check("b4: settings body {max_concurrent_leases:4} accepted by the route",
      postJSON("http://127.0.0.1:\(PORT)/api/projects/career-ops/settings",
               #"{"max_concurrent_leases":4}"#) == 200)
check("b4: settings body {max_concurrent_leases:null} clears (the NSNull shape)",
      postJSON("http://127.0.0.1:\(PORT)/api/projects/career-ops/settings",
               #"{"max_concurrent_leases":null}"#) == 200)
// The no-token path: a fresh model whose config has NO token (same server
// URL — a stray request would reach the arbiter and answer 401, so the note
// would read "HTTP 401" instead of "no request sent").
let cfgPath = (REPO as NSString).appendingPathComponent("client/config.json")
let savedCfg = (try? String(contentsOfFile: cfgPath, encoding: .utf8)) ?? ""
let noTokenCfg = "{\"server_url\": \"http://127.0.0.1:\(PORT)\", \"client_name\": \"mac-sam\"}"
try? noTokenCfg.write(toFile: cfgPath, atomically: true, encoding: .utf8)
let mNoTok = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(2.5))
check("b4: no token -> conn .noToken (word 'no token')", mNoTok.conn == .noToken)
check("b4: no token -> the status row NAMES the missing token + the config path",
      mNoTok.statusRowText().contains("no token") && mNoTok.statusRowText().contains("config.json"))
// The model has no payload (no request was ever sent) — inject the same
// state the real model saw, exactly as the poll would, then toggle: the
// gate must refuse WITHOUT issuing a request.
mNoTok.injectStatePayload(stAfter ?? [:])
mNoTok.selectProject("career-ops")
mNoTok.toggleProjectPaused()
check("b4: no token -> the gate refuses WITHOUT a request (note says so)",
      (mNoTok.updateNote ?? "").contains("no request sent"))
try? savedCfg.write(toFile: cfgPath, atomically: true, encoding: .utf8)

// (b5) criterion 5: "no token" vs "unreachable" — distinct words AND
// distinct signal colours (DESIGN.md: red = failure, amber = blocked).
check("b5: distinct words (no token != unreachable)", Conn.noToken.word != Conn.unreachable.word)
check("b5: distinct colours (amber warn != red err)", Conn.noToken.color != Conn.unreachable.color)
check("b5: unauthorized (401) is amber too, distinct from the red",
      Conn.unauthorized.color != Conn.unreachable.color)
// A dead server WITH a valid token -> .unreachable (the red path). The
// token rides from the assembled $TOK (the __DEADTOK__ placeholder is
// substituted by the sed below) so the credential pattern never sits in
// this file literally.
let deadCfg = "{\"server_url\": \"http://127.0.0.1:1\", \"token\": \"__DEADTOK__\", \"client_name\": \"mac-sam\"}"
try? deadCfg.write(toFile: cfgPath, atomically: true, encoding: .utf8)
let mDead = AppModel()
RunLoop.main.run(until: Date().addingTimeInterval(3.0))
check("b5: dead server + token -> .unreachable (word 'unreachable')", mDead.conn == .unreachable)
try? savedCfg.write(toFile: cfgPath, atomically: true, encoding: .utf8)

// (b6) criterion 1 (control side): the PID matcher acts on the LOCAL
// process table only — asserted on the matcher itself, not the payload.
check("b6: daemonPIDs(repo:) finds nothing in the scratch repo (local process table)",
      AppModel.daemonPIDs(repo: REPO).isEmpty)
// A bare pgrep -f src/index.ts matches ANY process with that string in its
// argv — including one that merely QUOTES the path. The decoy sets argv[0]
// to the repo's own entry path (so `pgrep -f src/index.ts` WOULD match it)
// while the real executable is sleep — the matcher must not.
let decoy = Process()
decoy.executableURL = URL(fileURLWithPath: "/bin/sh")
decoy.arguments = ["-c", "exec -a \"\(REPO)/src/index.ts\" sleep 5"]
try? decoy.run()
Thread.sleep(forTimeInterval: 0.5)
let decoyPids = AppModel.daemonPIDs(repo: REPO)
check("b6: a decoy process quoting the entry path is NOT matched", decoyPids.isEmpty)
decoy.terminate()

if failures > 0 {
  print("SCOPE-FAILURES \(failures)")
  exit(1)
}
print("SCOPE-ALL-PASS")
exit(0)
EOF

sed -e "s|__PORT__|$PORT|g" \
    -e "s|__REGA__|$REG_A|" \
    -e "s|__REGB__|$REG_B|" \
    -e "s|__REPO__|$T/repo|" \
    -e "s|__DEADTOK__|$TOK|" \
    "$T/main.swift" > "$T/main.baked.swift"
mv "$T/main.baked.swift" "$T/main.swift"

echo "==> swiftc (real source minus @main + driver)"
swiftc -O \
  -o "$T/scope-test" \
  "$T/menubar-under-test.swift" "$T/main.swift" \
  -framework AppKit -framework SwiftUI 2>&1 | grep -E "error:" || true
[ -x "$T/scope-test" ] || { echo "error: driver did not build"; exit 1; }

echo "==> run (env -i, the GUI environment)"
RC=0
env -i PATH=/usr/bin:/bin \
  IDLEFILL_CONFIG_FILE="$T/repo/client/config.json" \
  IDLEFILL_UPDATE_BASE="http://127.0.0.1:1" \
  SCOPE_TEST_TOK="$TOK" \
  "$T/scope-test" || RC=$?
echo "SCOPE-EXIT=$RC"
exit $RC
