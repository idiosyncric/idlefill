/**
 * page-agents.test.ts — the #72 Add-agent flow, BEHAVIOR side.
 *
 * The dashboard is one hand-written file (server/public/index.html) with the
 * entire client as an inline <script> — outside tsc, outside any DOM library.
 * This harness runs the REAL inline script text in a vm against stubbed
 * document/fetch/localStorage (the repo's extract → stub → assert recipe)
 * and asserts what the page actually does:
 *
 *   1. the script boots clean (TDZ-on-load family);
 *   2. no token → the Agents pane names the requirement and NO
 *      /api/client-keys or /api/agent-endpoints request leaves the page;
 *   3. token set → the rows read fires BOTH authoring GETs (30 s cadence
 *      timer, not the 5 s live poll) and the rows render label + id + age;
 *   4. the anonymous /api/state poll NEVER carries the token (the gate
 *      token rides authoring reads/writes only);
 *   5. the mint: POST /api/client-keys {label}, then the one-time hand-off
 *      block shows the EXACT Hermes config.yaml shape (model: provider:
 *      custom / base_url / api_key) with the minted plaintext;
 *   6. copy config copies the whole block; copy key copies just the key
 *      (the textarea+execCommand clipboard path);
 *   7. the minted plaintext appears exactly ONCE client-side: it rides NO
 *      fetch URL, NO localStorage write, and dies when the modal closes
 *      (rows re-render from the public-rows cache — no secret);
 *   8. revoke is the two-step arm (first click arms, second posts {id});
 *   9. Esc closes the modal; the create-state modal carries no token input.
 *
 * The #68 server + client suites cover the routes themselves — this file
 * covers the page wiring they exist for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = 'harness-gate-token'; // the CONTROL-API token the header field holds
const MINTED = 'idlk_mintedplaintext00000000000000000000'; // the AGENT key the stub mint hands once

// ---------------------------------------------------------------------------
// The stub DOM (the skill recipe: getElementById AUTO-CREATES — the script
// touches many ids at top level; a null would crash the boot before the
// first assertion, which is a harness gap, not a page bug).
// ---------------------------------------------------------------------------

type Listener = (e: any) => unknown;

function mkClassList(el: any) {
  const set = new Set<string>();
  return {
    add: (c: string) => set.add(c),
    remove: (c: string) => set.delete(c),
    contains: (c: string) => set.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set,
  } as any;
}

function mkEl(tag: string, id = ''): any {
  const el: any = {
    tagName: tag.toUpperCase(), id, dataset: {}, style: {},
    hidden: false, disabled: false, checked: false, value: '',
    textContent: '', length: 0, children: [],
    listeners: {} as Record<string, Listener[]>,
    _q: new Map<string, any>(), // memoized lazy querySelector children
    _html: '',
  };
  el.classList = mkClassList(el);
  el.setAttribute = (k: string, v: string) => { el.dataset[k] = v; };
  el.getAttribute = (k: string) => el.dataset[k] ?? null;
  el.addEventListener = (t: string, fn: Listener) => { (el.listeners[t] ||= []).push(fn); };
  el.focus = () => {}; el.blur = () => {}; el.scrollIntoView = () => {};
  el.select = () => {}; el.remove = () => {};
  el.click = () => { for (const fn of el.listeners.click || []) fn({ target: el, preventDefault: () => {} }); };
  el.append = (c: any) => { el.children.push(c); return c; };
  el.appendChild = (c: any) => { el.children.push(c); return c; };
  el.contains = () => true;
  el.closest = () => null;
  el.add = (opt: any) => { el.options.push(opt); el.length = el.options.length; };
  el.options = [];
  el.querySelector = (sel: string) => {
    if (!el._q.has(sel)) el._q.set(sel, mkEl('div', ''));
    return el._q.get(sel);
  };
  el.querySelectorAll = () => [];
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v: string) => { el._html = v; el._q = new Map(); },
  });
  return el;
}

/** Fire a stub element's click listeners with a hand-made event. */
async function fire(el: any, type: string, ev: any) {
  for (const fn of el.listeners[type] || []) await fn(ev);
}

test('#72 the Agents pane wiring: token-gated reads, one-time mint hand-off, two-step revoke', async () => {
  // ---- extract the REAL inline script the page ships ----------------------
  const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
  const sStart = html.indexOf('<script>\n"use strict"');
  assert.ok(sStart > 0, 'the inline script is on the page');
  const script = html.slice(sStart + '<script>'.length, html.indexOf('</script>', sStart));
  assert.ok(script.length > 100_000, 'the extracted script is the whole client');

  // ---- markup presence (the ids the wiring hangs on) ----------------------
  for (const id of ['id="add-agent"', 'id="add-agent-form"', 'id="client-keys"', 'id="rtab-agents"', 'data-subview="agents"']) {
    assert.ok(html.includes(id), `markup carries ${id}`);
  }
  // The modal is an overlay dialog (NOT the inline settings-form family).
  assert.match(html, /class="modal-backdrop"/, 'the modal overlay mechanism is on the page');

  // The script references every route + id the flow needs (the cheap half
  // of the wiring contract; behavior is asserted below by RUNNING it).
  for (const ref of ['add-agent', 'add-agent-form', 'client-keys', '/api/client-keys', '/api/agent-endpoints', '/api/client-keys/revoke']) {
    assert.ok(script.includes(ref), `the script references ${ref}`);
  }
  // The config-snippet shape (the Hermes config.yaml schema).
  assert.match(script, /provider: custom/, 'the script carries provider: custom');
  assert.match(script, /base_url: /, 'the script carries base_url:');
  assert.match(script, /api_key: /, 'the script carries api_key:');
  // The one-time posture is said plainly in the block itself.
  assert.match(script, /shown ONCE/, 'the block states the plaintext is shown once');

  // ---- stub ground truth ---------------------------------------------------
  const statePayload = () => ({
    now: Date.parse('2026-10-07T12:00:00Z'),
    idle: { idle: true, degraded: false, seconds_since_activity: 400, source: 'feed' },
    leases: [], active_leases: [], clients: [{ name: 'mac-test', online: true }],
    projects: [], events: [], servers: [], catalog: [], model_aliases: [],
    sessions: [], throttled_jobs: [], mesh: { peers: [] },
  });
  let keysTable: { id: string; label: string; created_at: number }[] = [];
  const endpoints = [{ client: 'mac-test', url: 'http://127.0.0.1:18802/v1' }];
  const fetchCalls: { url: string; method: string; body?: string }[] = [];
  const copies: string[] = []; // what execCommand-clipboard saw
  const timers: { fn: () => unknown; ms: number }[] = [];
  const winListeners: Record<string, Listener[]> = {};

  const byId = new Map<string, any>();
  const getEl = (id: string) => {
    if (!byId.has(id)) byId.set(id, mkEl('div', id));
    return byId.get(id);
  };
  const sections = [
    Object.assign(mkEl('section'), { dataset: { view: 'resources', subview: 'agents' }, style: {} }),
  ];

  const documentStub: any = {
    getElementById: getEl,
    querySelector: (sel: string) => (sel === '.settings-form.open' ? null : getEl('doc:' + sel)),
    querySelectorAll: (sel: string) => (sel.includes('section[data-view]') ? sections : []),
    createElement: (tag: string) => mkEl(tag),
    elementFromPoint: () => null,
    execCommand: (cmd: string) => {
      if (cmd === 'copy') {
        const ta = documentStub._lastTextarea;
        copies.push(ta ? ta.value : '');
        return true;
      }
      return false;
    },
  };
  documentStub.body = mkEl('body');
  const origAppend = documentStub.body.appendChild;
  documentStub.body.appendChild = (c: any) => {
    if (c.tagName === 'TEXTAREA') documentStub._lastTextarea = c;
    return origAppend(c);
  };

  const store = new Map<string, string>();
  const sandbox: any = {
    document: documentStub,
    window: {
      isSecureContext: false,
      addEventListener: (t: string, fn: Listener) => { (winListeners[t] ||= []).push(fn); },
    },
    location: { pathname: '/', hash: '', origin: 'http://127.0.0.1:18801', hostname: '127.0.0.1' },
    navigator: {}, // no clipboard → the textarea+execCommand path (both paths asserted by the copy buttons working)
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
    crypto: { getRandomValues: (b: any) => { b.fill(1); return b; } },
    Option: class { text: string; value: string; selected: boolean; constructor(t: string, v: string) { this.text = t; this.value = v; this.selected = false; } },
    setTimeout, clearTimeout,
    setInterval: (fn: () => unknown, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => {},
    fetch: async (url: string, opts?: { method?: string; body?: string }) => {
      const method = opts?.method ?? 'GET';
      fetchCalls.push({ url, method, body: opts?.body });
      const path = url.split('?')[0];
      const send = (obj: unknown, status = 200) => ({
        ok: status < 400, status, json: async () => obj,
      });
      if (path === '/api/state') return send(statePayload());
      if (path === '/api/metrics') return send({ series: [] });
      if (path === '/api/client-keys' && method === 'GET') return send({ keys: keysTable });
      if (path === '/api/agent-endpoints') return send({ endpoints });
      if (path === '/api/client-keys' && method === 'POST') {
        const label = JSON.parse(opts!.body!).label;
        const row = { id: 'key-abc123', label, created_at: statePayload().now - 3_600_000 };
        keysTable = [...keysTable, row];
        return send({ ...row, token: MINTED }, 201);
      }
      if (path === '/api/client-keys/revoke' && method === 'POST') {
        keysTable = keysTable.filter((k) => k.id !== JSON.parse(opts!.body!).id);
        return send({ ok: true, revoked: JSON.parse(opts!.body!).id });
      }
      return send({ error: 'not stubbed' }, 404);
    },
  };
  sandbox.globalThis = sandbox;

  // ---- 1. the script boots clean (TDZ-on-load) ----------------------------
  const ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx, { filename: 'index-inline.js' });
  await new Promise((r) => setTimeout(r, 20)); // flush the boot refresh()

  // ---- 2. no token: the pane names the requirement, NO agent request ------
  const keysBox = getEl('client-keys');
  assert.match(keysBox.innerHTML, /paste the arbiter token/, 'no token → the pane names the requirement');
  assert.equal(
    fetchCalls.filter((c) => c.url.includes('/api/client-keys') || c.url.includes('/api/agent-endpoints')).length,
    0,
    'no token → no agent GET/POST leaves the page',
  );

  // ---- 3. token set → the authoring reads fire, rows render ---------------
  store.set('idlefill.token', GATE);
  await vm.runInContext('refreshAgents()', ctx);
  const keysGet = fetchCalls.find((c) => c.method === 'GET' && c.url.startsWith('/api/client-keys'));
  const epGet = fetchCalls.find((c) => c.method === 'GET' && c.url.startsWith('/api/agent-endpoints'));
  assert.ok(keysGet && keysGet.url.includes('token=' + GATE), 'GET /api/client-keys carries the stored token');
  assert.ok(epGet && epGet.url.includes('token=' + GATE), 'GET /api/agent-endpoints carries the stored token');
  // The empty state stays the honest sentence (enforcement OFF while empty).
  assert.match(keysBox.innerHTML, /no agent keys minted — the aggregate endpoint accepts any caller on this machine/, 'empty state states the zero-config posture');

  // The authoring cadence: 30 s (the Models pane's pattern), and one of the
  // registered timers is the refreshAgents interval — NOT the 5 s live poll.
  const agentTimer = timers.find((t) => t.ms === 30_000 && String(t.fn).includes('refreshAgents'));
  assert.ok(agentTimer, 'a 30 s authoring timer drives refreshAgents');
  assert.ok(!timers.some((t) => t.ms === 5_000 && String(t.fn).includes('refreshAgents')), 'refreshAgents is NOT on the 5 s live cadence');

  // ---- 4. the anonymous poll never carries the token ----------------------
  await vm.runInContext('refresh()', ctx);
  for (const c of fetchCalls.filter((c) => c.url.startsWith('/api/state'))) {
    assert.ok(!c.url.includes(GATE), 'the /api/state poll stays anonymous even with the token stored');
  }

  // ---- 5. open the modal, mint, and read the one-time block ---------------
  await fire(getEl('add-agent'), 'click', {});
  const modal = getEl('add-agent-form');
  assert.equal(modal.hidden, false, 'the add-agent button opens the modal');
  const modalBody = () => getEl('add-agent-body').innerHTML;
  assert.match(modalBody(), /id="ag-label"/, 'the modal carries the label field');
  assert.match(modalBody(), /id="ag-machine"/, 'the modal carries the machine select');
  assert.match(modalBody(), /<option value="0" selected/, 'exactly one endpoint → preselected');
  assert.match(modalBody(), /another machine needs that machine\u2019s own dashboard|another machine needs that machine's own dashboard/, 'the modal says a remote machine needs its own dashboard');
  assert.ok(!/<input[^>]*token[^>]*>/i.test(modalBody()), 'no token input anywhere in the modal');

  getEl('ag-label').value = 'accounting-agent';
  getEl('ag-machine').value = '0';
  const mintBtn = { tagName: 'BUTTON', dataset: { act: 'mint' }, closest: (sel: string) => (sel === 'button[data-act]' ? mintBtn : null) };
  await fire(modal, 'click', { target: mintBtn });
  const mintPost = fetchCalls.find((c) => c.method === 'POST' && c.url.split('?')[0] === '/api/client-keys');
  assert.ok(mintPost && mintPost.url.includes('token=' + GATE), 'the mint rides settingsPost (?token=)');
  assert.deepEqual(JSON.parse(mintPost!.body!), { label: 'accounting-agent' }, 'the mint body is exactly {label}');

  // The one-time hand-off block: the EXACT Hermes config.yaml shape.
  const expectedConfig = 'model:\n  provider: custom\n  base_url: http://127.0.0.1:18802/v1\n  api_key: ' + MINTED + '\n';
  assert.ok(modalBody().includes(expectedConfig), 'the block carries the paste-ready config verbatim');
  assert.match(modalBody(), /shown ONCE/, 'the block states the plaintext never comes back');
  assert.match(modalBody(), /digest/, 'the block says the arbiter keeps only the digest');
  assert.match(modalBody(), /copy config[\s\S]*copy key/, 'both copy buttons ride the block');

  // ---- 6. the two clipboard paths -----------------------------------------
  const cfgBtn = { tagName: 'BUTTON', dataset: { act: 'copy-config', rest: 'copy config' }, classList: mkClassList({}), textContent: 'copy config', closest: (sel: string) => (sel === 'button[data-act]' ? cfgBtn : null) };
  await fire(modal, 'click', { target: cfgBtn });
  assert.ok(copies.some((c) => c === expectedConfig), 'copy config copies the WHOLE block');
  const keyBtn = { tagName: 'BUTTON', dataset: { act: 'copy-key', rest: 'copy key' }, classList: mkClassList({}), textContent: 'copy key', closest: (sel: string) => (sel === 'button[data-act]' ? keyBtn : null) };
  await fire(modal, 'click', { target: keyBtn });
  assert.ok(copies.some((c) => c === MINTED), 'copy key copies JUST the key');

  // ---- 7. the plaintext appears exactly once client-side ------------------
  for (const c of fetchCalls) {
    assert.ok(!c.url.includes(MINTED), 'the minted plaintext rides NO fetch URL');
    assert.ok(!(c.body || '').includes(MINTED), 'the minted plaintext rides NO request body');
  }
  for (const v of store.values()) assert.ok(!v.includes(MINTED), 'the minted plaintext never reaches localStorage');

  // Close → the block is wiped, the rows re-render from the public cache.
  await fire(modal, 'click', { target: { dataset: { act: 'done' }, closest: (sel: string) => (sel === 'button[data-act]' ? { dataset: { act: 'done' } } : null) } });
  await new Promise((r) => setTimeout(r, 20)); // the close-triggered refreshAgents lands
  assert.equal(modal.hidden, true, 'the done button closes the modal');
  assert.equal(getEl('add-agent-body').innerHTML, '', 'closing WIPES the one-time block (the plaintext is gone from the DOM)');
  assert.match(keysBox.innerHTML, /accounting-agent/, 'closing after a mint re-renders the rows list');
  assert.match(keysBox.innerHTML, /key-abc123/, 'rows carry the id');
  assert.match(keysBox.innerHTML, /1h 0m ago/, 'rows carry the created age (ago())');
  assert.ok(!keysBox.innerHTML.includes(MINTED), 'the re-rendered rows carry NO plaintext');

  // Esc opens-shut posture: reopen + Esc closes.
  await fire(getEl('add-agent'), 'click', {});
  assert.equal(modal.hidden, false, 'reopen works');
  for (const fn of winListeners.keydown || []) fn({ key: 'Escape' });
  assert.equal(modal.hidden, true, 'Esc closes the modal');

  // ---- 8. revoke is the two-step arm --------------------------------------
  const rmBtn: any = {
    tagName: 'BUTTON', dataset: { keyRemove: 'key-abc123' }, disabled: false, textContent: 'revoke',
    classList: mkClassList({}),
    closest: (sel: string) => (sel === 'button[data-key-remove]' ? rmBtn : null),
  };
  await fire(keysBox, 'click', { target: rmBtn });
  assert.equal(rmBtn.textContent, 'confirm?', 'first click arms the revoke');
  assert.equal(fetchCalls.filter((c) => c.url.includes('/api/client-keys/revoke')).length, 0, 'the armed click posts NOTHING');
  await fire(keysBox, 'click', { target: rmBtn });
  const revPost = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/api/client-keys/revoke'));
  assert.ok(revPost, 'the second click posts the revoke');
  assert.deepEqual(JSON.parse(revPost!.body!), { id: 'key-abc123' }, 'the revoke body is exactly {id}');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(keysBox.innerHTML, /no agent keys minted — the aggregate endpoint accepts any caller on this machine/, 'revoking to empty restores the honest OFF sentence');
});
