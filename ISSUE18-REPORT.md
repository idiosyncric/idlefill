# ISSUE18 report — README "Install" section

## What changed

`README.md` only: a new **`## Install`** section inserted after the intro
("Two parts" block) and before **Phase status** — where a newcomer looks,
ahead of the deployment internals.

The section says:

- Prereqs: Node 22+ and npm; no special network, just a reachable arbiter.
- `git clone https://github.com/idiosyncric/idlefill` → `npm install` at the repo root.
- Server: `cp server/config.example.json server/config.json` (set `api_tokens`),
  `cd server && npm run dev`.
- Client: `cp config.example.json config.json`, set `server_url` to the
  arbiter (`http://<arbiter-host>:8787`) and `token` to match the server's
  `api_tokens`, then `npm run start`.
- Notes that both `config.json` files are gitignored, the dashboard URL, and
  a pointer to the existing Quickstart/Architecture sections for the Docker
  path. No tailnet-specific assumptions in the new text.

## Verification (all against THIS checkout)

- Branch guard: `git symbolic-ref --short HEAD` → `issue-18-readme-install`. ✔
- Example files exist with the exact names: `client/config.example.json`,
  `server/config.example.json` (ls). ✔
- Gitignored: `.gitignore` lines 5–6 (`server/config.json`, `client/config.json`),
  confirmed via `git check-ignore -v`. ✔
- Commands quoted from real files, not invented:
  - `npm install` at root — root `package.json` declares workspaces
    (`server`, `client`, `adapters/career-ops`, `adapters/noop`).
  - `npm run dev` (server) — `server/package.json` `"dev": "tsx src/index.ts"`.
    (Chosen over `npm start`, which runs `node dist/index.js` and needs a
    prior `npm run build`; the README's own Quickstart uses the tsx path too.)
  - `npm run start` (client) — `client/package.json` `"start": "tsx src/index.ts"`.
  - Config keys `server_url` + `token` (client) and `api_tokens` (server) —
    read from the two example files.
  - Port 8787 — `server/config.example.json` `"listen": 8787`.
- `git diff --stat` before commit: only `README.md` touched. ✔

## Not done (per scope)

No GitHub repo creation, no remote, no push, no merge — orchestrator's job.
