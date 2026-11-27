import { createHash } from 'node:crypto';
import { fail, rec, same, token } from './config.mjs';

const CODE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FORM_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 200;
const MAX_TOKENS = 200;

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
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return true;
  // Allow native desktop custom URI schemes (e.g. cursor://, vscode://) while blocking dangerous ones
  if (/^[a-z][a-z0-9+.-]{1,30}:$/.test(u.protocol) && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(u.protocol)) {
    return true;
  }
  return false;
}

function s256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
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
  constructor({ cfg, auth, isRemote }) {
    this.cfg = cfg;
    this.auth = auth;
    this.isRemote = isRemote;
    this.clients = new Map();
    this.forms = new Map();
    this.codes = new Map();
    this.tokens = new Map();
  }

  resolveToken(rawToken) {
    const recEntry = this.tokens.get(rawToken);
    if (!recEntry) return null;
    if (Date.now() > recEntry.exp) {
      this.tokens.delete(rawToken);
      return null;
    }
    if (!recEntry.profileId) return { profile: null };
    const pr = (this.cfg.get().profiles || []).find((p) => p.id === recEntry.profileId);
    return pr ? { profile: pr } : null;
  }

  protectedResourceMetadata(origin, resourcePath = '/mcp') {
    return {
      resource: origin + resourcePath,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools']
    };
  }

  authorizationServerMetadata(origin) {
    return {
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools']
    };
  }

  async handleRegister(req) {
    const body = await readFormOrJson(req);
    if (!rec(body)) throw fail('Invalid client registration payload.');
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
      throw fail('Valid redirect_uris array is required.');
    }
    if (this.clients.size >= MAX_CLIENTS) {
      this.clients.delete(this.clients.keys().next().value);
    }
    const clientId = 'shelf_cli_' + token().slice(0, 20);
    const client = {
      client_id: clientId,
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'MCP Client',
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
    this.clients.set(clientId, client);
    return client;
  }

  renderAuthorizePage(req, urlObj, errorMessage = '') {
    const q = urlObj.searchParams;
    const clientId = q.get('client_id') || '';
    const redirectUri = q.get('redirect_uri') || '';
    const responseType = q.get('response_type') || '';
    const state = q.get('state') || '';
    const codeChallenge = q.get('code_challenge') || '';
    const codeChallengeMethod = q.get('code_challenge_method') || 'S256';

    const client = this.clients.get(clientId);
    if (!client || !client.redirect_uris.includes(redirectUri)) {
      throw fail('Unknown client_id or unregistered redirect_uri.');
    }
    if (responseType !== 'code') {
      throw fail('Only response_type=code is supported.');
    }
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      throw fail('PKCE with code_challenge_method=S256 is required.');
    }

    const nonce = token().slice(0, 32);
    const now = Date.now();
    for (const [k, v] of this.forms) {
      if (now - v.at > FORM_TTL_MS) this.forms.delete(k);
    }
    this.forms.set(nonce, {
      clientId,
      redirectUri,
      state,
      codeChallenge,
      at: now
    });

    const profiles = this.cfg.get().profiles || [];
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
      if (!this.auth.verifyPassword(body.password)) {
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

    const code = 'code_' + token().slice(0, 32);
    this.codes.set(code, {
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.codeChallenge,
      profileId,
      exp: Date.now() + CODE_TTL_MS
    });

    redirect.searchParams.set('code', code);
    if (flow.state) redirect.searchParams.set('state', flow.state);
    return { redirect: redirect.href };
  }

  async handleToken(req) {
    const body = await readFormOrJson(req);
    if (body.grant_type !== 'authorization_code') {
      throw fail('Unsupported grant_type.', 400);
    }
    const code = String(body.code || '');
    const clientId = String(body.client_id || '');
    const redirectUri = String(body.redirect_uri || '');
    const verifier = String(body.code_verifier || '');

    const recCode = this.codes.get(code);
    this.codes.delete(code);
    if (!recCode || Date.now() > recCode.exp) {
      throw fail('Invalid or expired authorization code.', 400);
    }
    if (!same(clientId, recCode.clientId) || !same(redirectUri, recCode.redirectUri)) {
      throw fail('Client or redirect_uri mismatch.', 400);
    }
    if (!verifier || !same(s256(verifier), recCode.codeChallenge)) {
      throw fail('Invalid PKCE code_verifier.', 400);
    }

    if (this.tokens.size >= MAX_TOKENS) {
      this.tokens.delete(this.tokens.keys().next().value);
    }
    const accessToken = token();
    this.tokens.set(accessToken, {
      clientId,
      profileId: recCode.profileId,
      exp: Date.now() + TOKEN_TTL_MS
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      scope: 'mcp:tools'
    };
  }
}
