Agent-facing quick reference for work in this repo. The README is the

convention authority; this file pins the facts and traps that have cost

agents time. (README "Conventions" points here — this file exists now.)

Commands

• Node 22, ESM, TypeScript strict, npm workspaces. Hermes terminals export

  NODE_ENV=production, which makes npm silently skip devDependencies —

  unset NODE_ENV (or prefix NODE_ENV=) for every npm/npx command.

• Verify: npm run test (node:test via tsx), npm run build,

  npx tsc --noEmit per package.

• Never commit build output (menubar/[IdlefillMenubar.app](http://IdlefillMenubar.app)) or gitignored

  config (server/config.json, client/config.json — the latter holds the

  live arbiter token).

Git / Forgejo — read before pushing

• Remote origin = [https://git.samwarth.com/sam/idlefill.git](https://git.samwarth.com/sam/idlefill.git). HTTPS, always.

• Never add or use an SSH remote ([git@forgejo.samwarth.com](mailto:git@forgejo.samwarth.com):...). ssh

  ignores GIT_CONFIG_GLOBAL and the profile home, authenticates with Sam's

  m1max-rack key, and silently pushes as sam — it "succeeds" with wrong

  attribution and no error. [forgejo.samwarth.com](http://forgejo.samwarth.com) has no HTTPS git route

  (404); the canonical host is [git.samwarth.com](http://git.samwarth.com).

• Push as your own agent identity: the profile's GIT_CONFIG_GLOBAL +

  home/.git-credentials are already wired (e.g. Web Dev Agent

  [web-dev@agents.samwarth.com](mailto:web-dev@agents.samwarth.com)). Sanity-check with

  git config [user.email](http://user.email) before your first commit.

• Forgejo API: `curl -H "Authorization: token $FORGEJO_TOKEN"

  [https://git.samwarth.com/api/v1/...\`](https://git.samwarth.com/api/v1/...`) — $FORGEJO_TOKEN is exported from the

  profile .env (provisioned for web-dev, pr-agent). Never extract it from

  .git-credentials with inline $(grep/sed) one-liners.

• After every main advance push BOTH remotes:

  git push origin main &amp;&amp; git push github main — github is the public

  mirror (push-only; never fetch/pull from it, no PR flow there).

• Per-issue work lands on a branch + PR or as directed by the dispatcher;

  merges to main need the owner's explicit go.

Reports &amp; releases

• Per-issue build reports go in docs/reports/ (indexed by its README) —

  never at the repo root.

• Releases are cut by tag, never by merge: bump root package.json to the

  next release number, then git tag v&lt;N&gt; main &amp;&amp; git push origin v&lt;N&gt;.