import fs from 'node:fs';
import http from 'node:http';
import { createHmac, scryptSync } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  APP_VERSION,
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
  publicUrlFromEnv,
  rec,
  same,
  signature,
  source,
  token,
  toolId
} from './config.mjs';
import { answer, Catalog, checks, createMcp, meta, safeClose } from './catalog.mjs';

const security = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
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

function createAuth(cfg, adminPassword) {
  const salt = 'mcp-shelf-auth-v1';
  const expectedHash = adminPassword ? scryptSync(adminPassword, salt, 32).toString('hex') : '';
  const sessionSecret = () => createHmac('sha256', cfg.get().token).update('session-key-v1').digest();
  const attempts = new Map();

  const clientKey = (req) =>
    String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .split(',')[0]
      .trim();

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
      attempts.set(k, { count: 1, since: now });
    } else {
      prev.count++;
    }
    if (attempts.size > 500) attempts.clear();
  };

  const clearFail = (req) => attempts.delete(clientKey(req));

  const verifyPassword = (candidate) => {
    if (typeof candidate !== 'string' || !expectedHash) return false;
    const h = scryptSync(candidate, salt, 32).toString('hex');
    return same(h, expectedHash);
  };

  const signSession = () => {
    const payload = `${Date.now() + SESSION_TTL_MS}.${token().slice(0, 24)}`;
    const sig = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
    return `${payload}.${sig}`;
  };

  const verifySession = (req) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return false;
    const parts = raw.split('.');
    if (parts.length !== 3) return false;
    const [expStr, nonce, sig] = parts;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const expected = createHmac('sha256', sessionSecret()).update(`${expStr}.${nonce}`).digest('hex');
    return same(sig, expected);
  };

  return { checkRateLimit, recordFail, clearFail, verifyPassword, signSession, verifySession };
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
  const cat = new Catalog(cfg);
  const csrf = token();
  const startedAt = Date.now();
  const auth = isRemote ? createAuth(cfg, adminPassword) : null;
  const publicHost = publicUrl ? new URL(publicUrl).host : '';

  if (demo && !cfg.get().servers.some((s) => s.id === 'demo')) {
    cfg.save({ ...cfg.get(), servers: [...cfg.get().servers, demoSource(['echo', 'add'])] });
  }

  const isHttpsReq = (req) =>
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
    publicUrl.startsWith('https://');

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
      if (publicHost && h !== publicHost && !localHosts.includes(h)) {
        return json(403, { error: 'Host not allowed.' });
      }
      if (req.headers.origin && !['http://' + h, 'https://' + h].includes(req.headers.origin)) {
        return json(403, { error: 'Origin not allowed.' });
      }
    }

    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw fail('Invalid URL.');
      const route = new URL(req.url, 'http://' + h).pathname;
      const method = req.method;

      // Lightweight SSE stream for stdio bridge to receive live tools/list_changed notifications
      if (route === '/mcp-events') {
        if (!same(req.headers.authorization, 'Bearer ' + cfg.get().token)) {
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

      // MCP Streamable HTTP endpoint
      if (route === '/mcp') {
        if (!same(req.headers.authorization, 'Bearer ' + cfg.get().token)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          return json(401, { error: 'Bearer token required.' });
        }
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          return json(405, { error: 'Use Streamable HTTP POST.' });
        }
        const request = await readBody(req);
        const mcp = createMcp(
          () => ({ tools: cat.metaTools(cfg.get().descriptions) }),
          async ({ name, arguments: a = {} }, extra) => {
            const validate = checks.get(name);
            if (!validate?.(a)) {
              throw new McpError(ErrorCode.InvalidParams, 'Unknown meta-tool or invalid arguments.');
            }
            if (name === 'list_mcps') return answer(await cat.list(a));
            if (name === 'search_tool') return answer(await cat.search(a));
            return cat.call(a, extra);
          },
          { instructions: cat.metaInstructions(), listChanged: true }
        );
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
        if (!rec(payload) || !auth.verifyPassword(payload.password)) {
          auth.recordFail(req);
          return json(401, { error: '管理密码不正确。' });
        }
        auth.clearFail(req);
        res.setHeader('Set-Cookie', sessionCookieHeader(req, auth.signSession(), SESSION_TTL_MS / 1000));
        return json(200, { ok: true });
      }

      if (method === 'POST' && route === '/api/auth/logout') {
        if (isRemote) {
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
          defaults,
          descriptions: cfg.get().descriptions,
          settings: cfg.get().settings,
          meta: meta.map(({ name, title }) => ({ name, title })),
          logCount: cat.logs.length,
          fingerprint: cat.fingerprint(),
          serverReminder: cat.serverReminder()
        });
      }

      if (method === 'POST' && route === '/api/token') {
        return json(200, { token: cfg.get().token });
      }

      if (method === 'POST' && route === '/api/token/rotate') {
        const nextToken = token();
        cfg.save({ ...cfg.get(), token: nextToken });
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

      const match = /^\/api\/servers\/([a-z][a-z0-9_-]{0,47})(\/refresh)?$/.exec(route);
      if (match) {
        const [, id, refresh] = match;
        const data = method === 'PUT' ? await readBody(req) : null;
        const now = cfg.get();
        const old = now.servers.find((s) => s.id === id);
        if (!old) throw fail('找不到连接。', 404);
        if (refresh && method === 'POST') {
          if (!old.enabled) throw fail('请先启用连接。', 409);
          const r = await cat.refresh(old, true);
          if (r.status !== 'ready') throw fail(r.error, 502);
          return json(200, { ok: true });
        }
        if (!refresh && method === 'DELETE') {
          cfg.save({ ...now, servers: now.servers.filter((s) => s.id !== id) });
          cat.invalidate(id);
          cat.notifyIfChanged();
          return json(200, { ok: true });
        }
        if (!refresh && method === 'PUT') {
          let next = source({ ...data, id });
          const changed = signature(next) !== signature(old);
          if (changed) next = { ...next, allowlist: [], overrides: Object.create(null) };
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
      await cat.close();
      await p;
    }
  };
}
