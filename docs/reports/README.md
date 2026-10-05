# Issue reports

Per-issue build reports written by the implementing agent when the work lands:
what was built, decisions honored, harness + build output, live verification.
They are a historical record — the living documentation is `README.md` at the
repo root (conventions, architecture, operator procedures).

New issue reports land **here**, never at the repo root.

| Issue | Report | Subject |
| --- | --- | --- |
| #2 | [ISSUE2-REPORT.md](ISSUE2-REPORT.md) | Score-ordered dispatch + `add_jobs` response echo |
| #3 | [ISSUE3-REPORT.md](ISSUE3-REPORT.md) | Scheduled scan → queue rebuild loop |
| #4 | [ISSUE4-REPORT.md](ISSUE4-REPORT.md) | Job results over REST (arbiter-stored outcomes) |
| #6 | [ISSUE6-REPORT.md](ISSUE6-REPORT.md) | Per-job lease TTL (client-side) |
| #9 A | [ISSUE9-ROUTER-REPORT.md](ISSUE9-ROUTER-REPORT.md) | Client-as-router session gate (router + queue + hold) |
| #9 B | [ISSUE9-DASHBOARD-REPORT.md](ISSUE9-DASHBOARD-REPORT.md) | Dashboard Sessions panel |
| #9 C | [ISSUE9-MENUBAR-REPORT.md](ISSUE9-MENUBAR-REPORT.md) | Menubar: sessions at a glance |
| #9 research | [ISSUE9-RESEARCH-HERMES-SURFACES.md](ISSUE9-RESEARCH-HERMES-SURFACES.md) | Hermes surfaces for a session gate |
| #9 research | [ISSUE9-RESEARCH-IDLEFILL-SEAMS.md](ISSUE9-RESEARCH-IDLEFILL-SEAMS.md) | Seam map for issue #9 + Forgejo tracker capability |
| #12 | [ISSUE12-REPORT.md](ISSUE12-REPORT.md) | Menu bar: multi-machine / multi-project scope |
| #14 | [ISSUE14-REPORT.md](ISSUE14-REPORT.md) | Per-project MCP tool policy |
| #15 | [ISSUE15-REPORT.md](ISSUE15-REPORT.md) | MCP tool-module extension point (discovered tools) |
| #18 | [ISSUE18-REPORT.md](ISSUE18-REPORT.md) | README "Install" section |
| #23 | [ISSUE23-REPORT.md](ISSUE23-REPORT.md) | Update paths re-point the LaunchAgent |
| #26 | [ISSUE26-REPORT.md](ISSUE26-REPORT.md) | Branch/commit-tracking update channel (edge) |
| #27 | [ISSUE27-REPORT.md](ISSUE27-REPORT.md) | Menu bar panel rework |
| #9 D | [DESKTOP-SESSIONS-REPORT.md](DESKTOP-SESSIONS-REPORT.md) | Desktop Sessions tab (the interactive surface) |
| gate-state | [GATE-STATE-REPORT.md](GATE-STATE-REPORT.md) | Gate-state visibility on the session rows (#40) |
| #50 | [../architecture/mesh.md](../architecture/mesh.md) | Mesh topology decision lock (federation, identity, packaging) |
| #55 | [../architecture/fleet-service.md](../architecture/fleet-service.md) | Fleet service grilling: instance identity, roster, pairing (separate service) |
| #50 | [ISSUE50-READPLANE-REPORT.md](ISSUE50-READPLANE-REPORT.md) | Mesh read plane: /api/mesh, peer pull, dashboard Machines strip |
| #39 | [ISSUE39-RESCOPE.md](ISSUE39-RESCOPE.md) | Peer discovery re-scoped against the locked mesh transport |
| #53 | [../architecture/dev-cycles.md](../architecture/dev-cycles.md) | Dev-cycle grilling: cycle state machine on the lease/queue primitives + noop-adapter spike ([ISSUE53-GRILL-REPORT.md](ISSUE53-GRILL-REPORT.md)) |
| #51 | [../architecture/metrics-history.md](../architecture/metrics-history.md) | Metrics history grilling: JSONL retention store, query surface, mesh boundary |
| #51 | [ISSUE51-GRILL-REPORT.md](ISSUE51-GRILL-REPORT.md) | Metrics history grill: verified gaps + settled decisions |
| #49 | [ISSUE49-REPORT.md](ISSUE49-REPORT.md) | Daemon code-staleness: boot-revision handshake + `daemon behind` flag |
