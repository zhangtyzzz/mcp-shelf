import fs from 'node:fs';
import http from 'node:http';
import { createHmac, scrypt, scryptSync } from 'node:crypto';
import { promisify } from 'node:util';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const scryptAsync = promisify(scrypt);
const escHtml = (s) =>
  String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  APP_VERSION,
  BUILTIN_TEMPLATES,
  CLI_PATH,
  DEFAULT_DIR,
  DEFAULT_PORT,
  adminPasswordFromEnv,
  defaults,
  demoSource,
  descriptions,
  dirFromEnv,
  fail,
  hostFromEnv,
  modeFromEnv,
  normalizeSettings,
  openConfig,
  parseImportConfig,
  portFromEnv,
  profile as parseProfile,
  publicUrlFromEnv,
  rec,
  same,
  signature,
  source,
  token,
  toolId
} from './config.mjs';
import { answer, Catalog, checks, createMcp, meta, safeClose } from './catalog.mjs';
import { OAuthStore } from './oauth.mjs';
import { ShelfOAuthServer } from './oauth_server.mjs';
import { TaskManager } from './tasks.mjs';

const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw fail('Expected application/json', 415);
  }
  if (Number(req.headers['content-length']) > 1_048_576) {
    req.resume();
    throw fail('Request too large', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_048_576) throw fail('Request too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('Invalid JSON');
  }
}

const assetDefs = {
  '/': ['index.html', 'text/html'],
  '/style.css': ['style.css', 'text/css'],
  '/app.js': ['app.js', 'text/javascript'],
  '/i18n.js': ['i18n.js', 'text/javascript'],
  '/icon.svg': ['icon.svg', 'image/svg+xml']
};

const assetCache = new Map(
  Object.entries(assetDefs).map(([route, [file, type]]) => [
    route,
    { type: type + '; charset=utf-8', bytes: fs.readFileSync(new URL('../ui/' + file, import.meta.url)) }
  ])
);

// Preload all locale packs from ui/locales/*.js automatically
const localesDir = new URL('../ui/locales/', import.meta.url);
if (fs.existsSync(localesDir)) {
  for (const file of fs.readdirSync(localesDir)) {
    if (/^[A-Za-z0-9_-]+\.js$/.test(file)) {
      assetCache.set('/locales/' + file, {
        type: 'text/javascript; charset=utf-8',
        bytes: fs.readFileSync(new URL(file, localesDir))
      });
    }
  }
}

const SESSION_COOKIE = 'mcp_shelf_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function createAuth(cfg, adminPassword, { trustProxy = false } = {}) {
  const salt = 'mcp-shelf-auth-v1';
  const expectedHash = adminPassword ? scryptSync(adminPassword, salt, 32).toString('hex') : '';
  const sessionSecret = () => createHmac('sha256', cfg.get().token).update('session-key-v1').digest();
  const attempts = new Map();
  const revokedSessions = new Map();

  const clientKey = (req) => {
    if (trustProxy && req.headers['x-forwarded-for']) {
      // Rightmost entry is appended by the trusted reverse proxy
      const parts = String(req.headers['x-forwarded-for'])
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
    return String(req.socket?.remoteAddress || 'unknown');
  };

  const pruneAttempts = (now) => {
    for (const [k, v] of attempts) {
      if (now - v.since > LOGIN_WINDOW_MS) attempts.delete(k);
    }
    while (attempts.size >= 500) {
      attempts.delete(attempts.keys().next().value);
    }
  };

  const checkRateLimit = (req) => {
    const k = clientKey(req);
    const now = Date.now();
    const recEntry = attempts.get(k);
    if (!recEntry || now - recEntry.since > LOGIN_WINDOW_MS) return true;
    return recEntry.count < LOGIN_MAX_FAILS;
  };

  const recordFail = (req) => {
    const k = clientKey(req);
    const now = Date.now();
    const prev = attempts.get(k);
    if (!prev || now - prev.since > LOGIN_WINDOW_MS) {
      pruneAttempts(now);
      attempts.set(k, { count: 1, since: now });
    } else {
      prev.count++;
    }
  };

  const clearFail = (req) => attempts.delete(clientKey(req));

  const verifyPassword = async (candidate) => {
    if (typeof candidate !== 'string' || !expectedHash || candidate.length > 256) return false;
    const h = (await scryptAsync(candidate, salt, 32)).toString('hex');
    return same(h, expectedHash);
  };

  const signSession = () => {
    const payload = `${Date.now() + SESSION_TTL_MS}.${token().slice(0, 24)}`;
    const sig = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
    return `${payload}.${sig}`;
  };

  const revokeSession = (req) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return;
    const parts = raw.split('.');
    if (parts.length !== 3) return;
    const exp = Number(parts[0]);
    const nonce = parts[1];
    const now = Date.now();
    for (const [k, e] of revokedSessions) {
      if (now > e) revokedSessions.delete(k);
    }
    while (revokedSessions.size >= 500) {
      revokedSessions.delete(revokedSessions.keys().next().value);
    }
    if (Number.isFinite(exp) && exp > now) revokedSessions.set(nonce, exp);
  };

  const verifySession = (req) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 3) return false;
    const [expStr, nonce, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    if (revokedSessions.has(nonce)) return false;
    const expected = createHmac('sha256', sessionSecret()).update(`${expStr}.${nonce}`).digest('hex');
    return same(sig, expected);
  };

  return { clientKey, checkRateLimit, recordFail, clearFail, verifyPassword, signSession, revokeSession, verifySession };
}

export async function launch({
  dir = dirFromEnv(),
  port = portFromEnv(),
  demo = false,
  mode = modeFromEnv(),
  host = hostFromEnv(mode),
  publicUrl = publicUrlFromEnv(),
  adminPassword = adminPasswordFromEnv()
} = {}) {
  const isLoopbackHost = ['127.0.0.1', '::1', 'localhost'].includes(host);
  const isRemote = mode === 'remote' || !isLoopbackHost;
  if (isRemote && adminPassword.length < 12) {
    throw new Error(
      '远程模式必须设置至少 12 位的 MCP_SHELF_ADMIN_PASSWORD 环境变量以保护管理台。'
    );
  }

  const cfg = openConfig(dir);
  const oauthStore = new OAuthStore(dir);
  const cat = new Catalog(cfg, oauthStore);
  const tasks = new TaskManager();
  const csrf = token();
  const startedAt = Date.now();
  const trustProxy = String(process.env.MCP_SHELF_TRUST_PROXY || '').toLowerCase() === 'true';
  const auth = isRemote ? createAuth(cfg, adminPassword, { trustProxy }) : null;
  const oauthServer = new ShelfOAuthServer({
    cfg,
    auth,
    isRemote,
    dir,
    clientKey: auth?.clientKey
  });
  const publicHost = publicUrl ? new URL(publicUrl).host : '';
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : '';

  const resolveAccess = (authHeader, expectedProfileId = null) => {
    const raw = String(authHeader || '');
    if (!raw.startsWith('Bearer ')) return null;
    const tok = raw.slice(7);
    if (!expectedProfileId && same(tok, cfg.get().token)) {
      return { profile: null, rawToken: tok };
    }
    for (const pr of cfg.get().profiles || []) {
      if (expectedProfileId && pr.id !== expectedProfileId) continue;
      if (same(tok, pr.token)) return { profile: pr, rawToken: tok };
    }
    const oauthHit = oauthServer.resolveToken(tok);
    if (oauthHit) {
      if (expectedProfileId && oauthHit.profile?.id !== expectedProfileId) return null;
      return { profile: oauthHit.profile, rawToken: tok };
    }
    return null;
  };

  const buildMcpServer = (activeProfile) => {
    const profileId = activeProfile?.id || null;
    return createMcp(
      () => ({ tools: cat.metaTools(cfg.get().descriptions, activeProfile) }),
      async (params, extra) => {
        const { name, arguments: a = {}, task: taskParams } = params;
        const validate = checks.get(name);
        if (!validate?.(a)) {
          throw new McpError(ErrorCode.InvalidParams, 'Unknown meta-tool or invalid arguments.');
        }
        if (name === 'list_mcps') return answer(await cat.list(a, activeProfile));
        if (name === 'search_tool') return answer(await cat.search(a, activeProfile));
        if (taskParams && typeof taskParams === 'object') {
          const created = tasks.start({
            toolId: a.tool_id,
            profileId,
            ttl: taskParams.ttl,
            run: (signal) => cat.call(a, { signal }, activeProfile, 300_000)
          });
          return { task: created };
        }
        return cat.call(a, extra, activeProfile);
      },
      {
        instructions: cat.metaInstructions(activeProfile),
        listChanged: true,
        taskHandlers: {
          get: (id) => tasks.get(id, profileId),
          result: (id, signal) => tasks.result(id, profileId, signal),
          list: () => tasks.list(profileId),
          cancel: (id) => tasks.cancel(id, profileId)
        }
      }
    );
  };

  if (demo && !cfg.get().servers.some((s) => s.id === 'demo')) {
    cfg.save({ ...cfg.get(), servers: [...cfg.get().servers, demoSource(['echo', 'add'])] });
  }

  const isHttpsReq = (req) =>
    publicUrl.startsWith('https://') ||
    (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

  const sessionCookieHeader = (req, value, maxAgeSec) => {
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`
    ];
    if (isHttpsReq(req)) parts.push('Secure');
    return parts.join('; ');
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(security)) res.setHeader(k, v);
    if (isHttpsReq(req)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const json = (code, x) => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(x));
      }
    };

    const p = server.address().port;
    const h = req.headers.host;
    const localHosts = ['127.0.0.1:' + p, 'localhost:' + p];
    if (!h || /[\s/\\]/.test(h)) {
      return json(403, { error: 'Host not allowed.' });
    }
    if (!isRemote) {
      if (!localHosts.includes(h)) return json(403, { error: 'Host not allowed.' });
      if (req.headers.origin && req.headers.origin !== 'http://' + h) {
        return json(403, { error: 'Origin not allowed.' });
      }
    } else {
      const fwdHost = trustProxy
        ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
        : '';
      const safeFwdHost = fwdHost && !/[\s/\\]/.test(fwdHost) ? fwdHost : '';
      if (publicHost && h !== publicHost && !localHosts.includes(h)) {
        return json(403, { error: 'Host not allowed.' });
      }
      const allowedOrigins = ['http://' + h, 'https://' + h];
      if (publicOrigin) allowedOrigins.push(publicOrigin);
      if (trustProxy && !publicHost && safeFwdHost) {
        allowedOrigins.push('http://' + safeFwdHost, 'https://' + safeFwdHost);
      }
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
        return json(403, { error: 'Origin not allowed.' });
      }
    }

    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fail('Invalid URL.');
      const route = new URL(req.url, 'http://' + h).pathname;
      const method = req.method;

      // OAuth 2.1 callback endpoint (invoked by browser redirect from upstream auth server)
      if (method === 'GET' && route === '/api/oauth/callback') {
        const u = new URL(req.url, 'http://' + h);
        const code = u.searchParams.get('code');
        const stParam = u.searchParams.get('state');
        const errParam = u.searchParams.get('error');
        const html = (title, msg, ok = true) => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
              `<title>${escHtml(title)} · MCP Shelf</title><link rel="stylesheet" href="/style.css"></head>` +
              `<body><div class="login-wrap"><div class="login-card"><div class="kicker">MCP OAUTH 2.1</div>` +
              `<h2>${escHtml(title)}</h2><p class="sub">${escHtml(msg)}</p>` +
              `<div class="actions"><a class="btn primary" href="/">Return to MCP Shelf</a></div></div></div></body></html>`
          );
        };
        if (errParam) return html('OAuth Authorization Denied', `Upstream returned error: ${errParam}`, false);
        if (!code || !stParam) return html('Invalid OAuth Callback', 'Missing code or state parameter.', false);
        try {
          const { serverId: sid } = await oauthStore.finishAuth(stParam, code);
          const srv = cfg.get().servers.find((s) => s.id === sid);
          if (srv && srv.enabled) void cat.refresh(srv, true);
          return html('OAuth Connected', `Successfully authorized "${sid}". You can close this tab and return to MCP Shelf.`);
        } catch (err) {
          return html('OAuth Failed', err.message || 'Token exchange failed.', false);
        }
      }

      // Lightweight SSE stream for stdio bridge to receive live tools/list_changed notifications
      if (route === '/mcp-events') {
        const access = resolveAccess(req.headers.authorization);
        if (!access) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          return json(401, { error: 'Bearer token required.' });
        }
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          return json(405, { error: 'Use GET for event stream.' });
        }
        req.setTimeout(0);
        res.setTimeout(0);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive'
        });
        res.write(`event: ready\ndata: ${JSON.stringify({ fingerprint: cat.fingerprint() })}\n\n`);
        const unsub = cat.onChange((fp) => {
          if (!res.destroyed) {
            res.write(`event: tools_changed\ndata: ${JSON.stringify({ fingerprint: fp })}\n\n`);
          }
        });
        const keepAlive = setInterval(() => {
          if (!res.destroyed) res.write(': ping\n\n');
        }, 25_000);
        keepAlive.unref();
        res.once('close', () => {
          clearInterval(keepAlive);
          unsub();
        });
        return;
      }

      const fwdHostRaw = trustProxy
        ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
        : '';
      const effectiveHost = fwdHostRaw && !/[\s/\\]/.test(fwdHostRaw) ? fwdHostRaw : h;
      const reqOrigin = publicUrl || `${isHttpsReq(req) ? 'https' : 'http'}://${effectiveHost}`;

      // MCP Shelf's own OAuth 2.1 + PKCE Server endpoints (RFC 9728, RFC 8414, RFC 7591)
      if (method === 'GET' && route.startsWith('/.well-known/oauth-protected-resource')) {
        const suffix = route.slice('/.well-known/oauth-protected-resource'.length) || '/mcp';
        return json(200, oauthServer.protectedResourceMetadata(reqOrigin, suffix));
      }
      if (method === 'GET' && route === '/.well-known/oauth-authorization-server') {
        return json(200, oauthServer.authorizationServerMetadata(reqOrigin));
      }
      if (method === 'POST' && route === '/oauth/register') {
        return json(201, await oauthServer.handleRegister(req));
      }
      if (method === 'GET' && route === '/oauth/authorize') {
        const html = oauthServer.renderAuthorizePage(req, new URL(req.url, 'http://' + h));
        // A native form POST needs a same-origin policy to send a non-null Origin.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
        return res.end(html);
      }
      if (method === 'POST' && route === '/oauth/authorize') {
        const result = await oauthServer.handleAuthorizeSubmit(req);
        if (result.invalidPassword) {
          const retryUrl = new URL('/oauth/authorize', 'http://' + h);
          retryUrl.searchParams.set('client_id', result.flow.clientId);
          retryUrl.searchParams.set('redirect_uri', result.flow.redirectUri);
          retryUrl.searchParams.set('response_type', 'code');
          retryUrl.searchParams.set('code_challenge', result.flow.codeChallenge);
          retryUrl.searchParams.set('code_challenge_method', 'S256');
          if (result.flow.state) retryUrl.searchParams.set('state', result.flow.state);
          const html = oauthServer.renderAuthorizePage(req, retryUrl, 'Invalid admin password.');
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
          return res.end(html);
        }
        // Finish native form submissions on Shelf before navigating to the registered client callback.
        // Browsers may enforce form-action 'self' on redirects of the POST itself.
        if (String(req.headers.accept || '').includes('text/html')) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            Refresh: `0; url=${result.redirect}`
          });
          return res.end(
            `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
              `<title>MCP Shelf OAuth</title><link rel="stylesheet" href="/style.css"></head>` +
              `<body><div class="login-wrap"><div class="login-card"><a class="btn primary" href="${escHtml(result.redirect)}">Continue to your MCP client</a></div></div></body></html>`
          );
        }
        res.writeHead(302, { Location: result.redirect });
        return res.end();
      }
      if (method === 'POST' && route === '/oauth/token') {
        return json(200, await oauthServer.handleToken(req));
      }

      // MCP Streamable HTTP endpoint (supports /mcp and profile-scoped /mcp/<profile_id>)
      const mcpMatch = /^\/mcp(?:\/([a-z][a-z0-9_-]{0,47}))?$/.exec(route);
      if (mcpMatch) {
        const expectedProfileId = mcpMatch[1] || null;
        const access = resolveAccess(req.headers.authorization, expectedProfileId);
        if (!access) {
          res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${reqOrigin}/.well-known/oauth-protected-resource${route}"`
          );
          return json(401, { error: 'Bearer token required.' });
        }
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(405, { error: 'Use Streamable HTTP POST.' });
        }
        const request = await readBody(req);
        const mcp = buildMcpServer(access.profile);
        const tr = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        await mcp.connect(tr);
        res.once('close', () => {
          void safeClose(mcp);
        });
        await tr.handleRequest(req, res, request);
        return;
      }

      // Health check endpoint (loopback Host-restricted, no secrets)
      if (method === 'GET' && route === '/healthz') {
        return json(200, {
          ok: true,
          version: APP_VERSION,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
        });
      }

      // Static UI assets (served from memory cache)
      if (method === 'GET' && assetCache.has(route)) {
        const asset = assetCache.get(route);
        res.writeHead(200, { 'Content-Type': asset.type });
        return res.end(asset.bytes);
      }

      if (!route.startsWith('/api/')) return json(404, { error: 'Not found.' });
      if (
        req.headers['sec-fetch-site'] &&
        !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])
      ) {
        return json(403, { error: 'Cross-site request denied.' });
      }

      // Auth endpoints (always accessible in remote mode so the UI can sign in/out)
      if (method === 'GET' && route === '/api/auth/me') {
        return json(200, {
          mode: isRemote ? 'remote' : 'local',
          authenticated: !isRemote || auth.verifySession(req),
          publicUrl: publicUrl || ''
        });
      }

      if (method === 'POST' && route === '/api/auth/login') {
        if (!isRemote) return json(200, { ok: true, mode: 'local' });
        if (!auth.checkRateLimit(req)) {
          return json(429, { error: '登录尝试过于频繁，请 15 分钟后再试。' });
        }
        const payload = await readBody(req);
        if (!rec(payload) || !(await auth.verifyPassword(payload.password))) {
          auth.recordFail(req);
          return json(401, { error: '管理密码不正确。' });
        }
        auth.clearFail(req);
        res.setHeader('Set-Cookie', sessionCookieHeader(req, auth.signSession(), SESSION_TTL_MS / 1000));
        return json(200, { ok: true });
      }

      if (method === 'POST' && route === '/api/auth/logout') {
        if (isRemote) {
          auth.revokeSession(req);
          res.setHeader('Set-Cookie', sessionCookieHeader(req, '', 0));
        }
        return json(200, { ok: true });
      }

      if (isRemote && !auth.verifySession(req)) {
        return json(401, { error: '请先登录管理台。', auth_required: true });
      }

      if (method !== 'GET' && !same(req.headers['x-shelf-csrf'], csrf)) {
        return json(403, { error: 'Missing admin CSRF token.' });
      }

      if (method === 'GET' && route === '/api/state') {
        const env = {};
        if (dir !== DEFAULT_DIR()) env.MCP_SHELF_HOME = dir;
        if (p !== DEFAULT_PORT) env.MCP_SHELF_PORT = String(p);
        const remoteEndpoint = publicUrl
          ? publicUrl + '/mcp'
          : (isHttpsReq(req) ? 'https://' : 'http://') + h + '/mcp';
        return json(200, {
          csrf,
          port: p,
          mode: isRemote ? 'remote' : 'local',
          publicUrl: publicUrl || '',
          remoteEndpoint,
          demo,
          configFile: cfg.file,
          bridge: { command: process.execPath, args: [CLI_PATH, 'stdio'], env },
          servers: cat.snapshot(),
          profiles: (cfg.get().profiles || []).map(({ token: _tok, ...rest }) => rest),
          templates: BUILTIN_TEMPLATES,
          defaults,
          descriptions: cfg.get().descriptions,
          settings: cfg.get().settings,
          meta: meta.map(({ name, title }) => ({ name, title })),
          logCount: cat.logs.length,
          fingerprint: cat.fingerprint(),
          serverReminder: cat.serverReminder()
        });
      }

      if (method === 'GET' && route === '/api/tasks') {
        return json(200, { tasks: tasks.snapshot() });
      }

      const taskCancelMatch = /^\/api\/tasks\/(task_[0-9a-f]{20})\/cancel$/.exec(route);
      if (taskCancelMatch && method === 'POST') {
        try {
          return json(200, { task: tasks.cancel(taskCancelMatch[1]) });
        } catch (err) {
          throw fail(err.message, 404);
        }
      }

      // Access Profiles CRUD (multi-machine / multi-project scoped credentials)
      if (method === 'POST' && route === '/api/profiles') {
        const next = parseProfile(await readBody(req));
        const now = cfg.get();
        if ((now.profiles || []).length >= 30) throw fail('Maximum 30 access profiles allowed.');
        if ((now.profiles || []).some((pr) => pr.id === next.id)) {
          throw fail('Profile ID already exists.', 409);
        }
        cfg.save({ ...now, profiles: [...(now.profiles || []), next] });
        return json(201, { ok: true, profile: { ...next, token: undefined }, token: next.token });
      }

      const profMatch = /^\/api\/profiles\/([a-z][a-z0-9_-]{0,47})(\/(?:token|rotate))?$/.exec(route);
      if (profMatch) {
        const [, pid, sub] = profMatch;
        const now = cfg.get();
        const existing = (now.profiles || []).find((pr) => pr.id === pid);
        if (!existing) throw fail('Profile not found.', 404);
        if (sub === '/token' && method === 'POST') {
          return json(200, { token: existing.token });
        }
        if (sub === '/rotate' && method === 'POST') {
          const nextTok = token();
          const updated = { ...existing, token: nextTok };
          cfg.save({ ...now, profiles: now.profiles.map((pr) => (pr.id === pid ? updated : pr)) });
          oauthServer.revokeByProfile(pid);
          return json(200, { ok: true, token: nextTok });
        }
        if (!sub && method === 'PUT') {
          const data = await readBody(req);
          const updated = parseProfile({ ...data, id: pid, token: existing.token });
          cfg.save({ ...now, profiles: now.profiles.map((pr) => (pr.id === pid ? updated : pr)) });
          return json(200, { ok: true });
        }
        if (!sub && method === 'DELETE') {
          cfg.save({ ...now, profiles: now.profiles.filter((pr) => pr.id !== pid) });
          oauthServer.revokeByProfile(pid);
          return json(200, { ok: true });
        }
      }

      if (method === 'POST' && route === '/api/token') {
        return json(200, { token: cfg.get().token });
      }

      if (method === 'POST' && route === '/api/token/rotate') {
        const nextToken = token();
        cfg.save({ ...cfg.get(), token: nextToken });
        oauthServer.revokeByProfile(null);
        return json(200, { ok: true, token: nextToken });
      }

      if (method === 'GET' && route === '/api/logs') {
        const limit = cfg.get().settings?.logLimit ?? 200;
        return json(200, { logs: limit > 0 ? cat.getLogs(limit) : [], settings: cfg.get().settings });
      }

      if (method === 'DELETE' && route === '/api/logs') {
        cat.clearLogs();
        return json(200, { ok: true });
      }

      if (method === 'PUT' && route === '/api/settings') {
        const next = normalizeSettings({ ...cfg.get().settings, ...(await readBody(req)) });
        cfg.save({ ...cfg.get(), settings: next });
        cat.applySettings();
        return json(200, { ok: true, settings: next });
      }

      if (method === 'GET' && route === '/api/export') {
        const mcpServers = Object.fromEntries(
          cfg.get().servers.map((s) => [
            s.id,
            s.transport === 'stdio'
              ? {
                  label: s.label,
                  description: s.description,
                  command: s.command,
                  args: s.args,
                  ...(s.cwd ? { cwd: s.cwd } : {}),
                  ...(s.envKeys?.length ? { envKeys: s.envKeys } : {}),
                  enabled: s.enabled
                }
              : {
                  label: s.label,
                  description: s.description,
                  url: s.url,
                  ...(s.bearerEnv ? { bearerEnv: s.bearerEnv } : {}),
                  enabled: s.enabled
                }
          ])
        );
        return json(200, { mcpServers });
      }

      if (method === 'PUT' && route === '/api/descriptions') {
        const next = descriptions(await readBody(req));
        cfg.save({ ...cfg.get(), descriptions: next });
        cat.notifyIfChanged();
        return json(200, { ok: true });
      }

      if (method === 'POST' && route === '/api/import/preview') {
        const payload = await readBody(req);
        if (!rec(payload)) throw fail('无效请求体');
        const parsed = parseImportConfig(payload.text);
        const existing = new Set(cfg.get().servers.map((s) => s.id));
        const items = parsed.items.map((item) => ({
          ...item,
          conflict: existing.has(item.server.id)
        }));
        return json(200, { format: parsed.format, items, skipped: parsed.skipped });
      }

      if (method === 'POST' && route === '/api/import') {
        const payload = await readBody(req);
        if (!rec(payload)) throw fail('无效请求体');
        const parsed = parseImportConfig(payload.text);
        const now = cfg.get();
        const existing = new Set(now.servers.map((s) => s.id));
        const toAdd = [];
        const skipped = [...parsed.skipped];
        for (const item of parsed.items) {
          if (existing.has(item.server.id)) {
            skipped.push({ id: item.server.id, reason: '连接 ID 已存在，已跳过' });
            continue;
          }
          existing.add(item.server.id);
          toAdd.push(item.server);
        }
        if (now.servers.length + toAdd.length > 40) {
          throw fail('导入后将超过 40 个连接上限。');
        }
        if (toAdd.length) {
          cfg.save({ ...now, servers: [...now.servers, ...toAdd] });
          cat.notifyIfChanged();
        }
        return json(201, {
          ok: true,
          imported: toAdd.map((s) => s.id),
          skipped
        });
      }

      if (method === 'POST' && route === '/api/tools/test') {
        const payload = await readBody(req);
        if (!rec(payload) || typeof payload.tool_id !== 'string' || !toolId.test(payload.tool_id)) {
          throw fail('无效的 tool_id。');
        }
        const args = payload.arguments === undefined ? {} : payload.arguments;
        if (!rec(args)) throw fail('参数必须是 JSON 对象。');
        const start = Date.now();
        const result = await cat.testCall({ tool_id: payload.tool_id, arguments: args });
        return json(200, { result, durationMs: Date.now() - start });
      }

      if (method === 'POST' && route === '/api/servers/refresh-all') {
        const results = await cat.refreshAll();
        return json(200, { ok: true, results });
      }

      if (method === 'POST' && ['/api/demo', '/api/servers'].includes(route)) {
        const next = route === '/api/demo' ? demoSource([]) : source(await readBody(req));
        const now = cfg.get();
        if (now.servers.length >= 40) throw fail('最多可配置 40 个连接。');
        if (now.servers.some((s) => s.id === next.id)) throw fail('连接 ID 已存在。', 409);
        cfg.save({ ...now, servers: [...now.servers, next] });
        cat.notifyIfChanged();
        if (route === '/api/demo') {
          const r = await cat.refresh(next, true);
          if (r.status !== 'ready') throw fail(r.error, 502);
        }
        return json(201, { ok: true });
      }

      const match = /^\/api\/servers\/([a-z][a-z0-9_-]{0,47})(\/(?:refresh|oauth\/start|oauth\/logout))?$/.exec(route);
      if (match) {
        const [, id, action] = match;
        const data = method === 'PUT' ? await readBody(req) : null;
        const now = cfg.get();
        const old = now.servers.find((s) => s.id === id);
        if (!old) throw fail('Connection not found.', 404);
        if (action === '/refresh' && method === 'POST') {
          if (!old.enabled) throw fail('Enable connection first.', 409);
          const r = await cat.refresh(old, true);
          if (r.status !== 'ready') throw fail(r.error, 502);
          return json(200, { ok: true });
        }
        if (action === '/oauth/start' && method === 'POST') {
          if (old.transport !== 'http' || old.authMode !== 'oauth') {
            throw fail('Connection is not configured for OAuth.', 400);
          }
          const callbackBase = publicUrl || `${isHttpsReq(req) ? 'https' : 'http'}://${h}`;
          const result = await oauthStore.startAuth(old, callbackBase + '/api/oauth/callback');
          if (result.status === 'authorized' && old.enabled) void cat.refresh(old, true);
          return json(200, result);
        }
        if (action === '/oauth/logout' && method === 'POST') {
          oauthStore.clear(id);
          cat.invalidate(id);
          return json(200, { ok: true });
        }
        if (!action && method === 'DELETE') {
          cfg.save({ ...now, servers: now.servers.filter((s) => s.id !== id) });
          oauthStore.clear(id);
          cat.invalidate(id);
          cat.notifyIfChanged();
          return json(200, { ok: true });
        }
        if (!action && method === 'PUT') {
          let next = source({ ...data, id });
          const changed = signature(next) !== signature(old);
          if (changed) {
            next = { ...next, allowlist: [], approvedHashes: Object.create(null), overrides: Object.create(null) };
          } else {
            // Auto-lock schemaHash for newly approved or explicitly re-approved tools
            const hashes = Object.assign(Object.create(null), old.approvedHashes || {}, next.approvedHashes || {});
            for (const toolNameStr of next.allowlist) {
              const curHash = cat.currentHash(id, toolNameStr);
              if (curHash && (!hashes[toolNameStr] || data?.reapproveTool === toolNameStr)) {
                hashes[toolNameStr] = curHash;
              }
            }
            for (const k of Object.keys(hashes)) {
              if (!next.allowlist.includes(k)) delete hashes[k];
            }
            next = { ...next, approvedHashes: hashes };
          }
          cfg.save({ ...now, servers: now.servers.map((s) => (s.id === id ? next : s)) });
          if (changed || old.enabled !== next.enabled) cat.invalidate(id);
          cat.notifyIfChanged();
          return json(200, { ok: true, permissions_reset: changed });
        }
      }

      return json(404, { error: 'Not found.' });
    } catch (e) {
      return json(e.status || 500, { error: e.status ? e.message : 'Request failed.' });
    }
  });

  // Must exceed upstream callTool timeout (30s) and stdio bridge timeout (60s)
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;

  await new Promise((ok, no) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        no(
          new Error(
            `端口 ${host}:${port} 已被占用。请先停止现有 MCP Shelf 实例，或用 MCP_SHELF_PORT=<端口> 指定其他端口。`
          )
        );
      } else {
        no(err);
      }
    });
    server.listen(port, host, ok);
  });

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return {
    server,
    config: cfg,
    catalog: cat,
    mode: isRemote ? 'remote' : 'local',
    url: 'http://' + displayHost + ':' + server.address().port,
    close: async () => {
      const p = new Promise((r) => server.close(r));
      server.closeAllConnections();
      tasks.close();
      await cat.close();
      await p;
    }
  };
}
