import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { fail, rec, same, serverId, token } from './config.mjs';

const CODE_TTL_MS = 5 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORM_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 200;
const MAX_TOKENS = 200;
const MAX_REFRESH_GRANTS = 200;
const MAX_FORMS = 200;
const MAX_CODES = 200;
const DCR_WINDOW_MS = 60 * 60_000;
const DCR_MAX_PER_WINDOW = 20;
const BLOCKED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'ftp:',
  'ws:',
  'wss:'
]);
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const REFRESH_TOKEN_RE = /^shelf_rt_([0-9a-f]{32})\.([0-9a-f]{64})\.([0-9a-f]{64})$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const GRANT_ID_RE = /^[0-9a-f]{32}$/;
const TOOL_SCOPE = 'mcp:tools';
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const tokenError = (oauthError, message) => Object.assign(fail(message), { oauthError });

function resourceFor(value, origin) {
  if (value == null) return null;
  const base = origin + '/mcp';
  if (value === base) return value;
  if (typeof value === 'string' && value.startsWith(base + '/') && serverId.test(value.slice(base.length + 1))) return value;
  throw tokenError('invalid_target', 'Unrecognized MCP resource.');
}

function esc(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validRedirectUri(raw) {
  if (typeof raw !== 'string' || raw.length > 1000) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  }
  // Allow native desktop custom URI schemes (e.g. cursor://, vscode://) while blocking unsafe ones
  if (/^[a-z][a-z0-9+.-]{1,30}:$/.test(u.protocol) && !BLOCKED_SCHEMES.has(u.protocol)) {
    return true;
  }
  return false;
}

function s256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function hashToken(raw) {
  return createHash('sha256').update(String(raw || '')).digest('hex');
}

async function readFormOrJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw fail('Request too large', 413);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      throw fail('Invalid JSON');
    }
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

/**
 * Built-in MCP OAuth 2.1 + PKCE Authorization Server (RFC 9728, RFC 8414, RFC 7591).
 * Allows any OAuth-capable MCP client (Grok Build, Claude Code, Antigravity, etc.)
 * to authenticate against MCP Shelf without manually copying Bearer tokens.
 */
export class ShelfOAuthServer {
  constructor({ cfg, auth, isRemote, accessTtlSeconds, dir = null, clientKey = null }) {
    this.cfg = cfg;
    this.auth = auth;
    this.isRemote = isRemote;
    this.clientKey = clientKey || ((req) => req.socket?.remoteAddress || 'unknown');
    // Leading underscore guarantees no collision with upstream serverId (/^[a-z].../)
    this.storePath = dir ? path.join(dir, 'oauth', '_server.json') : null;
    this.clients = new Map();
    this.forms = new Map();
    this.codes = new Map();
    this.dcrAttempts = new Map();
    this.accessTtlMs = accessTtlSeconds * 1000;
    this.replayKey = token();
    this.tokens = new Map();
    this.refreshGrants = new Map();
    this._load();
  }

  revokeByProfile(profileId) {
    const tokens = new Map([...this.tokens].filter(([, t]) => t.profileId !== profileId));
    const refreshGrants = new Map([...this.refreshGrants].filter(([, grant]) => grant.profileId !== profileId));
    if (tokens.size !== this.tokens.size || refreshGrants.size !== this.refreshGrants.size) {
      this._save({ tokens, refreshGrants });
    }
  }

  revokeAll() {
    if (this.tokens.size || this.refreshGrants.size) this._save({ tokens: new Map(), refreshGrants: new Map() });
  }

  _load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      const now = Date.now();
      if (rec(raw.clients)) {
        for (const [id, c] of Object.entries(raw.clients)) {
          if (rec(c) && typeof c.client_id === 'string' && Array.isArray(c.redirect_uris)) {
            this.clients.set(id, c);
          }
        }
      }
      if (typeof raw.replayKey === 'string' && HASH_RE.test(raw.replayKey) && rec(raw.refreshGrants)) {
        this.replayKey = raw.replayKey;
        for (const [id, grant] of Object.entries(raw.refreshGrants)) {
          if (GRANT_ID_RE.test(id) && rec(grant) && typeof grant.exp === 'number' && grant.exp > now &&
            this.clients.has(grant.clientId) && HASH_RE.test(grant.refreshHash) &&
            (grant.profileId === null || typeof grant.profileId === 'string') &&
            (grant.resource === null || typeof grant.resource === 'string')) {
            this.refreshGrants.set(id, grant);
          }
        }
      }
      if (rec(raw.tokens)) {
        for (const [h, t] of Object.entries(raw.tokens)) {
          if (HASH_RE.test(h) && rec(t) && typeof t.exp === 'number' && t.exp > now &&
            (t.grantId === undefined || this.refreshGrants.has(t.grantId))) {
            this.tokens.set(h, {
              clientId: String(t.clientId || ''),
              profileId: typeof t.profileId === 'string' ? t.profileId : null,
              exp: t.exp,
              ...(t.grantId && { grantId: t.grantId })
            });
          }
        }
      }
    } catch {
      // Ignore corrupt/unreadable state file and start clean
    }
  }

  _save({ tokens = this.tokens, refreshGrants = this.refreshGrants } = {}) {
    const now = Date.now();
    const grants = new Map([...refreshGrants].filter(([, grant]) => grant.exp > now));
    const access = new Map([...tokens].filter(([, t]) => t.exp > now && (!t.grantId || grants.has(t.grantId))));
    if (this.storePath) {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.storePath}.${token()}.tmp`;
      const payload = JSON.stringify({
        version: 2,
        clients: Object.fromEntries(this.clients),
        tokens: Object.fromEntries(access),
        refreshGrants: Object.fromEntries(grants),
        replayKey: this.replayKey
      }, null, 2);
      try {
        fs.writeFileSync(tmp, payload + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, this.storePath);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    this.tokens = access;
    this.refreshGrants = grants;
  }

  resolveToken(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken) return null;
    const h = hashToken(rawToken);
    const recEntry = this.tokens.get(h);
    if (!recEntry) return null;
    if (Date.now() >= recEntry.exp) {
      this.tokens.delete(h);
      this._save();
      return null;
    }
    const resource = this.refreshGrants.get(recEntry.grantId)?.resource || null;
    if (!recEntry.profileId) return { profile: null, resource };
    const pr = (this.cfg.get().profiles || []).find((p) => p.id === recEntry.profileId);
    return pr ? { profile: pr, resource } : null;
  }

  protectedResourceMetadata(origin, resourcePath = '/mcp') {
    return {
      resource: origin + resourcePath,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [TOOL_SCOPE]
    };
  }

  authorizationServerMetadata(origin) {
    return {
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: GRANT_TYPES,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [TOOL_SCOPE]
    };
  }

  async handleRegister(req) {
    const key = this.clientKey(req);
    const now = Date.now();
    for (const [k, v] of this.dcrAttempts) {
      if (now - v.since > DCR_WINDOW_MS) this.dcrAttempts.delete(k);
    }
    const prev = this.dcrAttempts.get(key);
    if (prev && prev.count >= DCR_MAX_PER_WINDOW) {
      throw fail('Too many client registrations. Try again later.', 429);
    }
    if (this.dcrAttempts.size >= 500 && !prev) {
      this.dcrAttempts.delete(this.dcrAttempts.keys().next().value);
    }
    this.dcrAttempts.set(key, prev ? { count: prev.count + 1, since: prev.since } : { count: 1, since: now });

    const body = await readFormOrJson(req);
    if (!rec(body)) throw fail('Invalid client registration payload.');
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      throw fail('Valid redirect_uris array is required.');
    }
    if (this.clients.size >= MAX_CLIENTS) {
      const activeClientIds = new Set([...this.tokens.values(), ...this.refreshGrants.values()]
        .filter((record) => record.exp > now).map((record) => record.clientId));
      let evicted = false;
      for (const cid of this.clients.keys()) {
        if (!activeClientIds.has(cid)) {
          this.clients.delete(cid);
          evicted = true;
          break;
        }
      }
      if (!evicted) throw fail('Maximum registered OAuth clients reached.', 429);
    }
    const clientId = 'shelf_cli_' + token().slice(0, 20);
    const client = {
      client_id: clientId,
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'MCP Client',
      redirect_uris: uris,
      grant_types: GRANT_TYPES,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
    this.clients.set(clientId, client);
    this._save();
    return client;
  }

  renderAuthorizePage(req, urlObj, errorMessage = '') {
    const q = urlObj.searchParams;
    const clientId = q.get('client_id') || '';
    const redirectUri = q.get('redirect_uri') || '';
    const responseType = q.get('response_type') || '';
    const state = q.get('state') || '';
    const resource = q.get('resource');
    const codeChallenge = q.get('code_challenge') || '';
    const codeChallengeMethod = q.get('code_challenge_method') || 'S256';

    const client = this.clients.get(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      throw fail('Unknown client_id or unregistered redirect_uri.');
    }
    if (responseType !== 'code') {
      throw fail('Only response_type=code is supported.');
    }
    if (state.length > 512) {
      throw fail('OAuth state parameter is too long.');
    }
    if (!PKCE_CHALLENGE_RE.test(codeChallenge) || codeChallengeMethod !== 'S256') {
      throw fail('PKCE with valid S256 code_challenge is required.');
    }

    const nonce = token().slice(0, 32);
    const now = Date.now();
    for (const [k, v] of this.forms) {
      if (now - v.at > FORM_TTL_MS) this.forms.delete(k);
    }
    while (this.forms.size >= MAX_FORMS) {
      this.forms.delete(this.forms.keys().next().value);
    }
    this.forms.set(nonce, {
      clientId,
      redirectUri,
      state,
      resource,
      codeChallenge,
      at: now
    });

    // Avoid enumerating Access Profile names to unauthenticated callers in remote mode
    const canListProfiles = !this.isRemote || Boolean(this.auth?.verifySession(req));
    const profiles = canListProfiles ? this.cfg.get().profiles || [] : [];
    const profileOptions = [
      '<option value="">All enabled connections (Master scope)</option>',
      ...profiles.map(
        (p) => `<option value="${esc(p.id)}">${esc(p.label)} (${esc(p.id)})</option>`
      )
    ].join('');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize ${esc(client.client_name)} · MCP Shelf</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="login-wrap">
    <form class="login-card" method="POST" action="/oauth/authorize">
      <div class="kicker">MCP OAUTH 2.1</div>
      <h2>Authorize ${esc(client.client_name)}</h2>
      <p class="sub">Grant this client access to your MCP Shelf gateway via OAuth 2.1 + PKCE.</p>
      <input type="hidden" name="nonce" value="${esc(nonce)}">
      <label>Access Scope
        <select name="profile_id">${profileOptions}</select>
      </label>
      ${
        this.isRemote
          ? '<label>Admin Password<input type="password" name="password" required autocomplete="current-password" placeholder="Enter MCP_SHELF_ADMIN_PASSWORD"></label>'
          : ''
      }
      ${errorMessage ? `<p class="err" role="alert">${esc(errorMessage)}</p>` : ''}
      <div class="actions">
        <button type="submit" name="decision" value="deny">Deny</button>
        <button type="submit" name="decision" value="approve" class="primary">Authorize</button>
      </div>
    </form>
  </div>
</body>
</html>`;
  }

  async handleAuthorizeSubmit(req) {
    const body = await readFormOrJson(req);
    const nonce = String(body.nonce || '');
    const flow = this.forms.get(nonce);
    if (!flow || Date.now() - flow.at > FORM_TTL_MS) {
      throw fail('Authorization session expired. Please restart from your MCP client.');
    }

    const redirect = new URL(flow.redirectUri);
    if (body.decision === 'deny') {
      this.forms.delete(nonce);
      redirect.searchParams.set('error', 'access_denied');
      if (flow.state) redirect.searchParams.set('state', flow.state);
      return { redirect: redirect.href };
    }

    if (this.isRemote) {
      if (!this.auth.checkRateLimit(req)) {
        throw fail('Too many failed attempts. Try again later.', 429);
      }
      if (!(await this.auth.verifyPassword(body.password))) {
        this.auth.recordFail(req);
        return { invalidPassword: true, flow };
      }
      this.auth.clearFail(req);
    }

    this.forms.delete(nonce);
    const profileId =
      typeof body.profile_id === 'string' &&
      (this.cfg.get().profiles || []).some((p) => p.id === body.profile_id)
        ? body.profile_id
        : null;

    const nowMs = Date.now();
    for (const [k, v] of this.codes) {
      if (nowMs > v.exp) this.codes.delete(k);
    }
    while (this.codes.size >= MAX_CODES) {
      this.codes.delete(this.codes.keys().next().value);
    }
    const code = 'code_' + token().slice(0, 32);
    this.codes.set(code, {
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.codeChallenge,
      resource: flow.resource,
      profileId,
      exp: nowMs + CODE_TTL_MS
    });

    redirect.searchParams.set('code', code);
    if (flow.state) redirect.searchParams.set('state', flow.state);
    return { redirect: redirect.href };
  }

  _refreshProof(grantId, secret) {
    // Authenticate previously issued tokens without storing a list of spent secrets.
    return createHmac('sha256', this.replayKey).update(`${grantId}.${secret}`).digest('hex');
  }

  _issueTokens(grantId, grant, now) {
    const secret = token();
    const refreshToken = `shelf_rt_${grantId}.${secret}.${this._refreshProof(grantId, secret)}`;
    const refreshGrants = new Map(this.refreshGrants);
    refreshGrants.set(grantId, { ...grant, refreshHash: hashToken(refreshToken) });
    const tokens = new Map([...this.tokens].filter(([, entry]) => entry.exp > now));
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    const accessToken = token();
    const exp = Math.min(now + this.accessTtlMs, grant.exp);
    tokens.set(hashToken(accessToken), { grantId, clientId: grant.clientId, profileId: grant.profileId, exp });
    this._save({ tokens, refreshGrants });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: Math.ceil((exp - now) / 1000),
      scope: TOOL_SCOPE
    };
  }

  _refreshTokens(body, origin) {
    const raw = body.refresh_token;
    const parsed = typeof raw === 'string' && REFRESH_TOKEN_RE.exec(raw);
    if (!parsed) throw tokenError('invalid_grant', 'Invalid or expired refresh token.');
    const [, grantId, secret, proof] = parsed;
    const grant = this.refreshGrants.get(grantId);
    const now = Date.now();
    if (!grant || grant.exp <= now || !same(body.client_id, grant.clientId) ||
      !this.clients.has(grant.clientId) ||
      (grant.profileId && !this.cfg.get().profiles.some((profile) => profile.id === grant.profileId)) ||
      !same(proof, this._refreshProof(grantId, secret))) {
      throw tokenError('invalid_grant', 'Invalid or expired refresh token.');
    }
    if (!same(hashToken(raw), grant.refreshHash)) {
      // Only an authentic, previously issued token with the same client can revoke the family.
      const refreshGrants = new Map(this.refreshGrants);
      refreshGrants.delete(grantId);
      this._save({ refreshGrants });
      throw tokenError('invalid_grant', 'Refresh token already used. Authorize this client again.');
    }
    const resource = resourceFor(body.resource, origin);
    if (resource && resource !== (grant.resource || origin + '/mcp')) {
      throw tokenError('invalid_target', 'Resource does not match the original grant.');
    }
    if (body.scope !== undefined && body.scope !== TOOL_SCOPE) {
      throw tokenError('invalid_scope', 'Scope does not match the original grant.');
    }
    return this._issueTokens(grantId, grant, now);
  }

  async handleToken(req, origin) {
    const body = await readFormOrJson(req);
    if (!rec(body)) throw tokenError('invalid_request', 'Invalid token request.');
    if (body.grant_type === 'refresh_token') return this._refreshTokens(body, origin);
    if (body.grant_type !== 'authorization_code') {
      throw tokenError('unsupported_grant_type', 'Unsupported grant_type.');
    }
    const code = String(body.code || '');
    const clientId = String(body.client_id || '');
    const redirectUri = String(body.redirect_uri || '');
    const verifier = String(body.code_verifier || '');

    const recCode = this.codes.get(code);
    this.codes.delete(code);
    const now = Date.now();
    if (!recCode || now >= recCode.exp || !this.clients.has(clientId)) {
      throw tokenError('invalid_grant', 'Invalid or expired authorization code.');
    }
    if (!same(clientId, recCode.clientId) || !same(redirectUri, recCode.redirectUri)) {
      throw tokenError('invalid_grant', 'Client or redirect_uri mismatch.');
    }
    if (!verifier || !same(s256(verifier), recCode.codeChallenge)) {
      throw tokenError('invalid_grant', 'Invalid PKCE code_verifier.');
    }

    const resource = resourceFor(recCode.resource, origin);
    const tokenResource = resourceFor(body.resource, origin);
    if (resource && tokenResource && resource !== tokenResource) {
      throw tokenError('invalid_target', 'Resource does not match the authorization request.');
    }
    if ([...this.refreshGrants.values()].filter((grant) => grant.exp > now).length >= MAX_REFRESH_GRANTS) {
      throw fail('Maximum active OAuth grants reached.', 429);
    }
    return this._issueTokens(token().slice(0, 32), {
      clientId,
      profileId: recCode.profileId,
      resource: resource || tokenResource,
      exp: now + REFRESH_TTL_MS
    }, now);
  }
}
