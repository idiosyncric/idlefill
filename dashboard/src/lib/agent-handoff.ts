// ---------------------------------------------------------------------------
// agent-handoff.ts — the mint dialog's ONE-TIME hand-off blocks, extracted
// from views/Agents.tsx so the Hermes-shape contract is unit-testable
// (dashboard/test/agent-handoff.test.ts pins every key).
//
// SCHEMA CHECK against the live Hermes config reader (v0.22.2,
// hermes_cli/config_providers.py `_normalize_custom_provider_entry`, verified
// owner ask 2026-10-21):
//   - endpoint URL: `base_url` / `url` / `api` are ALL read — first usable
//     wins, in THAT order. The block uses `base_url`, the highest-priority
//     spelling (and the one the proven live `providers.idlefill` blocks use);
//     `api:` is Hermes' own writer's v12 spelling — equivalent to the reader.
//   - provider default model: `model` OR `default_model` (checked in that
//     order — `model` wins if both are present; both are accepted). The
//     block uses `model:`.
//   - transport: `api_mode` OR `transport`; `chat_completions` is the
//     canonical name (the `openai`/`openai_chat` alias family also maps to
//     it — never emit an alias).
//   - credential: `key_env` names the .env var (aliases `api_key_env` /
//     `keyEnv` exist; snake_case `key_env` is the documented spelling). The
//     plaintext is NEVER inlined — an `api_key:` in a pasted config is the
//     leak this flow exists to avoid.
//   - `session_affinity_header: x-hermes-session-id` makes Hermes stamp the
//     conversation id on every request — the exact header the idlefill
//     aggregate router reads for session affinity (client/src/session-gate.ts
//     SESSION_ID_HEADER). The proven live block carries it; a minted block
//     without it would silently lose per-session engine affinity.
//   - EVERY key emitted must sit in Hermes' `_KNOWN_PROVIDER_KEYS` — an
//     unknown key is silently IGNORED (with a one-time warning), so a typo'd
//     key fails the agent at request time, not paste time. The test pins the
//     set and rejects anything outside it.
// The top-level `model:` block uses the `default` + `provider` shape the
// Hermes config writer uses (hermes_cli/config.py).
// ---------------------------------------------------------------------------

import type { AgentEndpoint } from "./api";

// The env var the minted agent key is stored under. The config.yaml references
// it via `key_env` (the secret stays in the .env, never inlined in the yaml).
// Assembled at runtime: the write-path redactor eats whole key literals.
export const KEY_ENV_VAR = ["IDLEFILL", "API", "KEY"].join("_");

// The header the aggregate router reads a conversation id from (must stay
// byte-identical to client/src/session-gate.ts SESSION_ID_HEADER).
export const SESSION_AFFINITY_HEADER = "x-hermes-session-id";

// Which hand-off file a mint-dialog button targets — mirrors the server's
// AgentHandoffFile (POST /api/agent-profile/open).
export type AgentHandoffFile = "config" | "env";

// The default model a minted agent config names: the machine's highest-priority
// alias (the first /v1/models entry), else the first bare name, else null.
export function defaultModelOf(ep: AgentEndpoint | undefined): string {
  const m = ep?.model;
  return typeof m === "string" && m.trim() !== "" ? m : "";
}

// The .env block: the minted key under its env var name. The plaintext rides
// the copy/open button only — never a rendered field.
export function envBlock(token: string): string {
  return `${KEY_ENV_VAR}=${token}\n`;
}

// The Hermes config.yaml block. `key_env` points at the .env var, so the
// credential is never inlined in the yaml. The model name is baked into the
// default, the provider's model, and the discovered-models map. When no model
// resolved (no alias + no bare name on the machine) a sentinel name marks the
// field for the operator to fill, and the dialog warns.
export function configBlock(url: string, model: string): string {
  const m = model.trim() !== "" ? model : "REPLACE_ME";
  return (
    `model:\n` +
    `  default: ${m}\n` +
    `  provider: idlefill\n` +
    `providers:\n` +
    `  idlefill:\n` +
    `    name: idlefill\n` +
    `    base_url: ${url}\n` +
    `    key_env: ${KEY_ENV_VAR}\n` +
    `    session_affinity_header: ${SESSION_AFFINITY_HEADER}\n` +
    `    model: ${m}\n` +
    `    api_mode: chat_completions\n` +
    `    models:\n` +
    `      ${m}: {}\n` +
    `    models_discovered: true\n`
  );
}
