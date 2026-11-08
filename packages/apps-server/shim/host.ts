/**
 * The standalone site's in-process host (DES-APPS-001 §7.1, §7.3, §8.2): the page's one script holds the
 * wicked-apps runtime's standalone entry and THIS, inside one function. The host
 *
 * - signs the viewer in with OIDC authorization code + PKCE (oauth4webapi): the verifier, state and nonce
 *   live in `sessionStorage` only across the redirect; `/auth/callback` is the same page, which exchanges the
 *   code, clears that storage, keeps the token in memory and replaces the URL. No refresh token: when the
 *   server answers 401 the page signs in again.
 * - talks to the runtime over an in-process MessageChannel (the runtime never listens on `window`, so no
 *   parent or opener can join), answering `artifact.read` from `GET /spec`, `data.query` from `POST /q/:id`,
 *   and `data.action` with the card crew generated, drawn here, outside the app's components. Run is armed
 *   after 600 ms; Cancel and expiry stop it.
 * - decides framing and enforces it: framed (`window.top !== window`), it refuses `data.action` itself with
 *   no network call ("Open to make changes"), whatever the runtime does.
 * - opens a link only to an `https` host the app lists, after showing the full URL.
 */

import * as oauth from 'oauth4webapi';

import type { AppActionCard, AppActionCardValue, AppActionPrepareResponse, AppActionRunResponse, AppSiteSpecResponse } from 'wicked-crew-api-types';

declare const wickedAppsStandalone: { boot(port: MessagePort, hello: Record<string, unknown>): void };
/** Tests only (`host.test.js`, built only by apps-server's own build; crew's `--outdir` build omits it): a framed page asks its parent for a token. Never in a published page. */
declare const __WK_TEST_FRAMED_TOKEN__: boolean;

interface Boot {
  app: { slug: string; name: string };
  origin: string;
  signIn: null | { profile: 'oidc' | 'entra'; issuer: string; clientId: string; scope: string; authorizationEndpoint: string; tokenEndpoint: string; idTokenAlgs?: string[] };
}

const PROTOCOL = 'wicked.editor';
const ENVELOPE = 1;
const SIGNIN_KEY = 'wk-apps-signin';
const ARM_MS = 600;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls !== undefined) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function readBoot(): Boot {
  const node = document.getElementById('wk-boot');
  return JSON.parse(node?.textContent ?? '{}') as Boot;
}

const boot = readBoot();
const framed = window.top !== window;
const host = el('div', 'wk-host');
host.setAttribute('data-testid', 'apps-host');
document.body.append(host);

let token: string | null = null;

// ── sign-in ────────────────────────────────────────────────────────────────────────────────

function server(): oauth.AuthorizationServer {
  const s = boot.signIn!;
  return { issuer: s.issuer, authorization_endpoint: s.authorizationEndpoint, token_endpoint: s.tokenEndpoint, ...(s.idTokenAlgs !== undefined && s.idTokenAlgs.length > 0 ? { id_token_signing_alg_values_supported: s.idTokenAlgs } : {}) };
}
const client = (): oauth.Client => ({ client_id: boot.signIn!.clientId });
const redirectUri = (): string => `${boot.origin}/auth/callback`;

async function beginSignIn(): Promise<void> {
  const s = boot.signIn!;
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  // The page's own query (its `url.<name>` bindings) comes back after the sign-in: bounded, and only ever as the
  // search of this site's `/` (never a path, an origin or the callback's parameters).
  const search = location.pathname === '/' && location.search.length <= 2000 ? location.search : '';
  sessionStorage.setItem(SIGNIN_KEY, JSON.stringify({ codeVerifier, state, nonce, search }));
  const url = new URL(s.authorizationEndpoint);
  url.searchParams.set('client_id', s.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', s.scope);
  url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  location.assign(url.href);
}

/** `/auth/callback`: exchange the code, clear the stored verifier, keep the token in memory, replace the URL. */
async function completeSignIn(): Promise<string> {
  const raw = sessionStorage.getItem(SIGNIN_KEY);
  sessionStorage.removeItem(SIGNIN_KEY);
  const here = new URL(location.href);
  history.replaceState(null, '', '/');
  if (raw === null) throw new Error('the sign-in started in another tab or expired: sign in again');
  const saved = JSON.parse(raw) as { codeVerifier: string; state: string; nonce: string; search?: unknown };
  if (typeof saved.search === 'string' && /^\?[^#]{0,1999}$/.test(saved.search)) history.replaceState(null, '', `/${saved.search}`);
  const as = server();
  const params = oauth.validateAuthResponse(as, client(), here, saved.state);
  const response = await oauth.authorizationCodeGrantRequest(as, client(), oauth.None(), params, redirectUri(), saved.codeVerifier);
  const result = await oauth.processAuthorizationCodeResponse(as, client(), response, { expectedNonce: saved.nonce, requireIdToken: boot.signIn!.profile === 'oidc' });
  // oidc sends the ID token (aud = the client id); entra sends the access token for the app's own scope.
  const t = boot.signIn!.profile === 'oidc' ? result.id_token : result.access_token;
  if (typeof t !== 'string' || t === '') throw new Error('the issuer answered without the token this site takes');
  return t;
}

/** A framed page has no sign-in of its own (an IdP refuses to be framed). Tests supply one through their parent. */
async function framedToken(): Promise<string | null> {
  if (typeof __WK_TEST_FRAMED_TOKEN__ === 'undefined' || !__WK_TEST_FRAMED_TOKEN__) return null;
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== window.parent || !isObj(e.data) || e.data['type'] !== 'wk-test-token' || typeof e.data['token'] !== 'string') return;
      window.removeEventListener('message', onMessage);
      resolve(e.data['token']);
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'wk-test-token-request' }, '*');
    setTimeout(() => resolve(null), 5_000);
  });
}

// ── pages the host draws before (or instead of) the app ────────────────────────────────────

function gate(title: string, lines: string[], button?: { label: string; onClick: () => void; testId: string }, link?: { label: string; href: string }): void {
  // An app already drawn (a sign-in that ended) goes away behind the gate: hidden, inert, never on top of it.
  for (const app of document.querySelectorAll('.wk-app')) {
    app.setAttribute('hidden', '');
    app.setAttribute('inert', '');
  }
  const main = el('main', 'wk-host-gate');
  main.setAttribute('data-testid', 'apps-gate');
  main.append(el('h1', 'wk-host-title', boot.app.name), el('h2', 'wk-host-sub', title));
  for (const l of lines) main.append(el('p', 'wk-host-line', l));
  if (button !== undefined) {
    const b = el('button', 'wk-host-btn wk-host-btn--pri', button.label);
    b.type = 'button';
    b.setAttribute('data-testid', button.testId);
    b.addEventListener('click', button.onClick);
    main.append(b);
  }
  if (link !== undefined) {
    const a = el('a', 'wk-host-btn wk-host-btn--pri', link.label);
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    main.append(a);
  }
  host.replaceChildren(main);
}

const issuerHost = (): string => (boot.signIn === null ? '' : new URL(boot.signIn.issuer).host);

function showSignIn(message?: string): void {
  if (framed) {
    gate('Open this app in its own tab', ['Sign-in does not work inside a frame.'], undefined, { label: `Open ${boot.app.name}`, href: `${boot.origin}/` });
    return;
  }
  gate(message ?? 'Sign in to open this app', [`You sign in at ${issuerHost()}.`], { label: 'Sign in', onClick: () => void beginSignIn(), testId: 'apps-sign-in' });
}

function showNoAccess(reason: string): void {
  // The server's reason, unless it only repeats the title (a role or group refusal says no more than that).
  const said = reason.trim().replace(/\.$/, '').toLowerCase() === "you don't have access to this app" ? '' : reason;
  gate("You don't have access to this app", [said === '' ? 'Ask the person who shared it to add you.' : said], framed ? undefined : { label: 'Sign in as someone else', onClick: () => void beginSignIn(), testId: 'apps-sign-in' });
}

// ── the API ────────────────────────────────────────────────────────────────────────────────

class SignedOut extends Error {}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T & { code?: string; error?: string } }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'omit', cache: 'no-store', redirect: 'error' });
  const json = (await r.json().catch(() => ({}))) as T & { code?: string; error?: string };
  if (r.status === 401 && boot.signIn !== null) {
    token = null;
    showSignIn('Your sign-in ended: sign in again');
    throw new SignedOut();
  }
  return { status: r.status, json };
}

// ── the card ───────────────────────────────────────────────────────────────────────────────

const shown = (v: AppActionCardValue['value']): string => (Array.isArray(v) ? v.map(String).join(', ') : v === null ? '(none)' : String(v));
const fromLabel = (v: AppActionCardValue): string => (v.from === 'crew' ? v.label.replace(/^filled by studio/, 'filled by this site') : v.label);

function valueRows(dl: HTMLElement, values: AppActionCardValue[]): void {
  for (const v of values) {
    dl.append(el('dt', 'wk-host-k', v.name));
    const dd = el('dd', 'wk-host-v');
    dd.append(el('span', 'wk-host-val', shown(v.value)), el('span', 'wk-host-from', fromLabel(v)));
    dl.append(dd);
  }
}

/** Draws the card and answers what the person chose: run, or not. */
function drawCard(prep: AppActionPrepareResponse): Promise<'run' | 'cancel' | 'expired'> {
  const c: AppActionCard = prep.card;
  return new Promise((resolve) => {
    const scrim = el('div', 'wk-host-scrim');
    const card = el('div', 'wk-host-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('data-testid', 'apps-card');
    const title = c.kind === 'row-write' ? `${c.verb} ${c.table}` : c.operation;
    card.setAttribute('aria-label', `Run ${c.action}?`);
    card.append(el('h2', 'wk-host-card-title', `Run ${c.action}?`), el('p', 'wk-host-op', title));
    if (c.appSays !== undefined && c.appSays !== '') card.append(el('p', 'wk-host-says', `The app says: ${c.appSays}`));
    const dl = el('dl', 'wk-host-kv');
    if (c.kind === 'row-write') {
      dl.append(el('dt', 'wk-host-k', 'Source'), el('dd', 'wk-host-v', `${c.source} as ${c.login}`));
      valueRows(dl, c.columns);
      valueRows(dl, c.key);
      dl.append(el('dt', 'wk-host-k', 'Rows'), el('dd', 'wk-host-v', c.rows), el('dt', 'wk-host-k', 'Table'), el('dd', 'wk-host-v', c.checks));
    } else {
      dl.append(el('dt', 'wk-host-k', 'Source'), el('dd', 'wk-host-v', `${c.source} (${c.sourceKind})`));
      valueRows(dl, c.args);
    }
    card.append(dl, el('pre', 'wk-host-pre', c.kind === 'row-write' ? c.statement : c.request));
    const left = el('p', 'wk-host-line');
    const actions = el('div', 'wk-host-actions');
    const cancel = el('button', 'wk-host-btn', 'Cancel');
    cancel.type = 'button';
    cancel.setAttribute('data-testid', 'apps-card-cancel');
    const run = el('button', 'wk-host-btn wk-host-btn--pri', 'Run it');
    run.type = 'button';
    run.disabled = true;
    run.setAttribute('data-testid', 'apps-card-run');
    actions.append(cancel, run);
    card.append(left, actions);
    scrim.append(card);
    host.append(scrim);
    let done = false;
    const finish = (how: 'run' | 'cancel' | 'expired'): void => {
      if (done) return;
      done = true;
      clearInterval(tick);
      clearTimeout(arm);
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      resolve(how);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish('cancel');
      }
    };
    document.addEventListener('keydown', onKey, true);
    const arm = setTimeout(() => {
      run.disabled = false;
    }, ARM_MS);
    const update = (): void => {
      const s = Math.max(0, Math.round((prep.expiresAt - Date.now()) / 1000));
      left.textContent = s > 0 ? `This card expires in ${s} s.` : 'This card expired: try again.';
      if (s === 0) finish('expired');
    };
    const tick = setInterval(update, 1000);
    update();
    cancel.addEventListener('click', () => finish('cancel'));
    run.addEventListener('click', () => {
      if (!run.disabled) finish('run');
    });
    cancel.focus();
  });
}

function confirmLink(href: string): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = el('div', 'wk-host-scrim');
    const card = el('div', 'wk-host-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('data-testid', 'apps-link');
    card.append(el('h2', 'wk-host-card-title', 'Open this link?'), el('pre', 'wk-host-pre', href));
    const actions = el('div', 'wk-host-actions');
    const no = el('button', 'wk-host-btn', 'Cancel');
    const yes = el('button', 'wk-host-btn wk-host-btn--pri', 'Open');
    no.type = 'button';
    yes.type = 'button';
    actions.append(no, yes);
    card.append(actions);
    scrim.append(card);
    host.append(scrim);
    const end = (ok: boolean): void => {
      scrim.remove();
      resolve(ok);
    };
    no.addEventListener('click', () => end(false));
    yes.addEventListener('click', () => end(true));
    no.focus();
  });
}

// ── the runtime ────────────────────────────────────────────────────────────────────────────

function startApp(site: AppSiteSpecResponse): void {
  host.replaceChildren();
  const channel = new MessageChannel();
  const port = channel.port1;
  let cardOpen = false;
  const reply = (id: string, ok: boolean, payload: Record<string, unknown>, error?: { code: string; message: string }): void => {
    port.postMessage({ p: PROTOCOL, v: ENVELOPE, re: id, ok, payload, ...(error !== undefined ? { error } : {}) });
  };
  const say = (type: string, payload: Record<string, unknown>): void => port.postMessage({ p: PROTOCOL, v: ENVELOPE, type, payload });
  const refuse = (id: string, code: string, message: string): void => reply(id, false, {}, { code, message });
  const actionsHere = !framed && site.actions;

  const onAction = async (id: string, p: Record<string, unknown>): Promise<void> => {
    // The host's own refusal, before any network call: a frame never writes (DES §7.1, S8).
    if (framed) return refuse(id, 'refused', 'Open to make changes');
    if (!site.actions) return refuse(id, 'refused', 'Actions are off on this site');
    if (cardOpen) return refuse(id, 'rate_limited', 'Finish the open card first');
    const action = typeof p['action'] === 'string' ? p['action'] : '';
    if (!site.spec.actions.some((a) => a.id === action)) return refuse(id, 'refused', 'This app has no such action');
    const params = isObj(p['params']) ? p['params'] : {};
    cardOpen = true;
    try {
      const prep = await api<AppActionPrepareResponse>('POST', `/a/${encodeURIComponent(action)}/prepare`, { params });
      if (prep.status !== 200) return refuse(id, prep.json.code ?? 'refused', prep.json.error ?? 'The action cannot run now');
      const how = await drawCard(prep.json);
      if (how !== 'run') return reply(id, true, { state: how === 'expired' ? 'refused' : 'cancelled', reason: how === 'expired' ? 'the card expired' : '' });
      const ran = await api<AppActionRunResponse>('POST', `/a/${encodeURIComponent(action)}/run`, { record: prep.json.record });
      // Any outcome (succeeded, failed or unknown) changes what the app reads: every visible query is read again.
      say('data.invalidate', {});
      if (ran.status !== 200) return refuse(id, ran.json.code ?? 'refused', ran.json.error ?? 'The action did not run');
      return reply(id, true, { state: ran.json.state, ...(ran.json.reason !== undefined ? { reason: ran.json.reason } : {}) });
    } catch (err) {
      if (err instanceof SignedOut) return undefined;
      return refuse(id, 'unavailable', 'The site did not answer');
    } finally {
      cardOpen = false;
    }
  };

  const onLink = async (id: string, p: Record<string, unknown>): Promise<void> => {
    const href = typeof p['href'] === 'string' ? p['href'] : '';
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return refuse(id, 'refused', 'Not a link');
    }
    const hosts = site.spec.linkHosts ?? [];
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || !hosts.includes(url.hostname)) return refuse(id, 'refused', 'This app does not list that host');
    if (!(await confirmLink(url.href))) return reply(id, true, { opened: false });
    window.open(url.href, '_blank', 'noopener,noreferrer');
    return reply(id, true, { opened: true });
  };

  port.onmessage = (m: MessageEvent): void => {
    const d = m.data as Record<string, unknown> | null;
    if (!isObj(d) || d['p'] !== PROTOCOL || d['v'] !== ENVELOPE || typeof d['type'] !== 'string') return;
    const id = typeof d['id'] === 'string' ? d['id'] : null;
    const p = isObj(d['payload']) ? d['payload'] : {};
    if (id === null) return; // a notice (selection.set, plugin.ready): nothing to answer on a read-only site
    switch (d['type']) {
      case 'artifact.read':
        return reply(id, true, { version: site.app.version, content: { type: 'app', spec: site.spec, readonly: true } });
      case 'data.query': {
        const query = typeof p['query'] === 'string' ? p['query'] : '';
        if (!site.spec.queries.some((q) => q.id === query)) return refuse(id, 'refused', 'This app has no such query');
        const params = isObj(p['params']) ? p['params'] : {};
        void api<Record<string, unknown>>('POST', `/q/${encodeURIComponent(query)}`, { params })
          .then((r) => (r.status === 200 ? reply(id, true, r.json) : refuse(id, r.json.code ?? 'refused', r.json.error ?? 'The query did not run')))
          .catch((err: unknown) => {
            if (!(err instanceof SignedOut)) refuse(id, 'unavailable', 'The site did not answer');
          });
        return;
      }
      case 'data.action':
        void onAction(id, p);
        return;
      case 'link.open':
        void onLink(id, p);
        return;
      default:
        return refuse(id, 'unsupported', 'This site is read-only');
    }
  };

  const url: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(location.search)) if (Object.keys(url).length < 30) url[k] = v;
  const grants = ['artifact.read', 'data.read', ...(actionsHere ? ['data.write'] : [])];
  wickedAppsStandalone.boot(channel.port2, {
    protocol: 2,
    surface: 'full',
    size: 'full',
    grants,
    app: { framed, mode: 'preview', viewer: site.viewer, url },
    prefs: { locale: navigator.language },
    theme: {},
  });
}

async function main(): Promise<void> {
  if (boot.signIn !== null) {
    if (location.pathname === '/auth/callback') {
      try {
        token = await completeSignIn();
      } catch (err) {
        showSignIn(`The sign-in did not finish (${err instanceof Error ? err.message : 'error'}): sign in again`);
        return;
      }
    } else if (location.pathname !== '/') {
      history.replaceState(null, '', '/');
    }
    if (token === null && framed) token = await framedToken();
    if (token === null) return showSignIn();
  }
  let r: Awaited<ReturnType<typeof api<AppSiteSpecResponse>>>;
  try {
    r = await api<AppSiteSpecResponse>('GET', '/spec');
  } catch (err) {
    if (!(err instanceof SignedOut)) gate('This app cannot be reached', ['The site did not answer: try again in a moment.']);
    return;
  }
  if (r.status === 403) return showNoAccess(r.json.error ?? '');
  if (r.status !== 200) return gate('This app cannot open', [r.json.error ?? 'The site refused to open it.']);
  startApp(r.json);
}

void main();
