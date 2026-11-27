import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import Ajv19 from 'ajv/dist/2019.js';
import Ajv20 from 'ajv/dist/2020.js';
import { APP_NAME, APP_VERSION, jsz, rec, serverId, toolId, toolName } from './config.mjs';

export const safeClose = (c) => c?.close().catch(() => {});

export const answer = (value, isError = false) => ({
  content: [{ type: 'text', text: isError ? String(value) : JSON.stringify(value) }],
  ...(isError ? { isError: true } : { structuredContent: value })
});

export const blocked = () =>
  answer('Tool unavailable or not allowed. Discover approved IDs with search_tool.', true);

const page = {
  limit: { type: 'integer', minimum: 1, maximum: 25 },
  offset: { type: 'integer', minimum: 0, maximum: 20_000 }
};
const SERVER_PREVIEW_LIMIT = 20;
const sid = { type: 'string', pattern: serverId.source, maxLength: 48 };
const tid = { type: 'string', pattern: toolId.source, maxLength: 177 };

const spec = (name, title, properties, required = [], readOnlyHint = true) => ({
  name,
  title,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: readOnlyHint
    ? { readOnlyHint: true, openWorldHint: true }
    : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
});

export const meta = [
  spec('list_mcps', 'List MCPs', { server_id: sid, ...page }),
  spec('search_tool', 'Search Tool', {
    query: { type: 'string', maxLength: 400 },
    server_id: sid,
    tool_id: tid,
    include_schema: { type: 'boolean' },
    ...page
  }),
  spec('call_tool', 'Call Tool', { tool_id: tid, arguments: { type: 'object' } }, ['tool_id'], false)
];

const validators = () =>
  [Ajv, Ajv19, Ajv20].map(
    (C) => new C({ strict: false, ownProperties: true, validateFormats: false, addUsedSchema: false })
  );

const gatewayAjv = validators()[0];
export const checks = new Map(meta.map((s) => [s.name, gatewayAjv.compile(s.inputSchema)]));

export const createMcp = (list, call, opts = APP_NAME) => {
  const { id = APP_NAME, instructions, listChanged = false, taskHandlers = null } =
    typeof opts === 'string' ? { id: opts } : opts || {};
  const capabilities = {
    tools: listChanged ? { listChanged: true } : {},
    ...(taskHandlers
      ? { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }
      : {})
  };
  const serverOpts = {
    capabilities,
    ...(instructions ? { instructions } : {})
  };
  const s = new Server({ name: id, version: APP_VERSION }, serverOpts);
  s.setRequestHandler(ListToolsRequestSchema, (r, e) => list(r, e));
  s.setRequestHandler(CallToolRequestSchema, (r, e) => call(r.params, e));
  if (taskHandlers) {
    s.setRequestHandler(GetTaskRequestSchema, (r) => taskHandlers.get(r.params.taskId));
    s.setRequestHandler(GetTaskPayloadRequestSchema, (r, e) =>
      taskHandlers.result(r.params.taskId, e.signal)
    );
    s.setRequestHandler(ListTasksRequestSchema, () => taskHandlers.list());
    s.setRequestHandler(CancelTaskRequestSchema, (r) => taskHandlers.cancel(r.params.taskId));
  }
  return s;
};

export const newClient = () => new Client({ name: APP_NAME, version: APP_VERSION });

export const httpClient = (url, headers = {}, authProvider = undefined, fetchFn = fetch) =>
  new StreamableHTTPClientTransport(new URL(url), {
    ...(authProvider ? { authProvider } : {}),
    requestInit: { headers },
    fetch: (i, o) => fetchFn(i, { ...o, redirect: 'error' })
  });

const allowed = (s, t) => s.allowlist.includes(t.name);
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

function sanitizeIcons(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const item of raw) {
    if (!rec(item) || typeof item.src !== 'string' || item.src.length > 4096) continue;
    if (!/^(?:https:\/\/|data:image\/(?:png|jpeg|webp|svg\+xml);)/i.test(item.src)) continue;
    out.push({
      src: item.src,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType.slice(0, 64) } : {}),
      ...(Array.isArray(item.sizes) ? { sizes: item.sizes.filter((x) => typeof x === 'string').slice(0, 4) } : {})
    });
    if (out.length >= 4) break;
  }
  return out.length ? out : undefined;
}
const cleanMsg = (s, max = 180) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function diagnoseConnectError(err, fallback, stderrTail = '') {
  const code = err?.code || err?.cause?.code;
  const msg = cleanMsg(err?.message);
  if (code === 'ENOENT') return `${fallback} (executable not found)`;
  if (code === 'EACCES') return `${fallback} (permission denied)`;
  if (code === 'ECONNREFUSED') return `${fallback} (connection refused)`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed?\s*out/i.test(msg)) {
    return `${fallback} (timed out)`;
  }
  const httpCode = /\b(401|403|404|405|500|502|503)\b/.exec(msg);
  if (httpCode) return `${fallback} (HTTP ${httpCode[1]})`;
  const tail = cleanMsg(stderrTail, 140);
  if (tail) return `${fallback} (${tail})`;
  if (msg && msg !== 'Error') return `${fallback} (${msg})`;
  return fallback;
}

function missingEnvKeysFor(s) {
  if (s.transport === 'stdio') {
    return (s.envKeys || []).filter((k) => process.env[k] == null || process.env[k] === '');
  }
  if (s.transport === 'http' && s.authMode === 'bearer' && s.bearerEnv && !process.env[s.bearerEnv]) {
    return [s.bearerEnv];
  }
  return [];
}

const profileAllows = (profile, sid) =>
  !profile || profile.scope === 'all' || (profile.scope === 'selected' && profile.servers.includes(sid));

const SENSITIVE_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie|credential/i;
const SEARCH_SCHEMA_BUDGET = 16_384;
const BACKOFF_STEPS_MS = [30_000, 60_000, 120_000, 300_000];

function redactValue(val, depth = 0) {
  if (depth > 5) return '[…]';
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') return val.length > 500 ? val.slice(0, 500) + '…' : val;
  if (Array.isArray(val)) return val.slice(0, 20).map((x) => redactValue(x, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val).slice(0, 40)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return val;
}

function previewJson(val, maxChars = 4000) {
  try {
    const str = JSON.stringify(redactValue(val), null, 2);
    if (!str) return '';
    return str.length > maxChars ? str.slice(0, maxChars) + '\n… [truncated]' : str;
  } catch {
    return '[unserializable]';
  }
}

export class Catalog {
  constructor(cfg, oauthStore = null) {
    this.cfg = cfg;
    this.oauthStore = oauthStore;
    this.states = new Map();
    this.calls = 0;
    this.logs = [];
    this.logSeq = 0;
    this.listeners = new Set();
    this.lastFingerprint = this.fingerprint();
    this.reaper = setInterval(() => this.evictIdle(), 60_000);
    this.reaper.unref();
  }

  isDrifted(s, t) {
    if (!allowed(s, t)) return false;
    const locked = s.approvedHashes?.[t.name];
    return Boolean(locked && t.schemaHash && locked !== t.schemaHash);
  }

  isUsable(s, t) {
    if (!allowed(s, t)) return false;
    if (this.cfg.get().settings?.strictSchemaDrift !== false && this.isDrifted(s, t)) {
      return false;
    }
    return true;
  }

  currentHash(serverId, toolNameStr) {
    const r = this.states.get(serverId);
    return r?.tools?.find((x) => x.name === toolNameStr)?.schemaHash || null;
  }

  evictIdle() {
    const idleMin = this.cfg.get().settings?.idleMinutes ?? 10;
    if (!idleMin || idleMin <= 0) return;
    const cutoff = Date.now() - idleMin * 60_000;
    for (const s of this.cfg.get().servers) {
      if (s.transport !== 'stdio') continue;
      const r = this.states.get(s.id);
      if (r && r.client && !r.pending && (r.lastUsed || r.at || 0) < cutoff) {
        const c = r.client;
        r.client = null;
        r.hibernated = true;
        void safeClose(c);
      }
    }
  }

  applySettings() {
    const limit = this.cfg.get().settings?.logLimit ?? 200;
    if (limit <= 0) this.logs.length = 0;
    else if (this.logs.length > limit) this.logs.length = limit;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  fingerprint(profile = null) {
    const c = this.cfg.get();
    const summary = {
      descriptions: c.descriptions,
      servers: c.servers
        .filter((s) => s.enabled && profileAllows(profile, s.id))
        .map((s) => ({
          id: s.id,
          label: s.label,
          description: s.description,
          allowlist: [...s.allowlist].sort()
        }))
        .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    };
    return createHash('sha256').update(JSON.stringify(summary)).digest('hex').slice(0, 12);
  }

  notifyIfChanged() {
    const fp = this.fingerprint();
    if (fp === this.lastFingerprint) return false;
    this.lastFingerprint = fp;
    for (const fn of this.listeners) {
      try {
        fn(fp);
      } catch {}
    }
    return true;
  }

  /**
   * Summarize configured approvals within the character budget.
   * Discovery and upstream health stay out of cache-sensitive tool descriptions.
   */
  serverReminder(maxChars = 1400, profile = null) {
    const active = this.cfg
      .get()
      .servers.filter((s) => s.enabled && s.allowlist.length > 0 && profileAllows(profile, s.id));
    if (!active.length) return '';

    const heading = 'Connected MCP servers:';
    const preview = active.slice(0, SERVER_PREVIEW_LIMIT);
    const overflow = (shown) =>
      shown < active.length ? `\n- (+${active.length - shown} more servers; call list_mcps)` : '';
    const details = preview.map((s) => {
      const count = s.allowlist.length;
      const word = count === 1 ? 'tool' : 'tools';
      const desc = cleanMsg(s.description || (s.label !== s.id ? s.label : ''), 120);
      const line = `- ${s.id} (${count} ${word})`;
      return desc ? `${line}: ${desc}` : line;
    });
    const detailed = `${[heading, ...details].join('\n')}${overflow(preview.length)}`;
    if (detailed.length <= maxChars) return detailed;

    // Prefer showing more complete server IDs when the detailed preview does not fit.
    const ids = preview.map(({ id }) => id);
    for (let shown = ids.length; shown > 0; shown--) {
      const compact = `${heading} ${ids.slice(0, shown).join(', ')}${overflow(shown)}`;
      if (compact.length <= maxChars) return compact;
    }

    const summary = `${heading} ${active.length}; call list_mcps`;
    return summary.length <= maxChars ? summary : '';
  }

  metaInstructions(profile = null) {
    const reminder = this.serverReminder(1400, profile);
    const usage =
      'Upstream tools behind MCP Shelf are proxied and NOT registered directly on the host. Always discover them with MCP Shelf `search_tool` and invoke them via MCP Shelf `call_tool({ tool_id, arguments })`. Never call `server/tool` or `server__tool` directly on the host.';
    return reminder ? `${reminder}\n\n${usage}` : usage;
  }

  metaTools(descs = this.cfg.get().descriptions, profile = null) {
    const reminder = this.serverReminder(480, profile);
    return meta.map((t) => {
      const base = descs[t.name];
      const description = reminder ? `${base}\n\n${reminder}` : base;
      return { ...t, description };
    });
  }

  record(entry) {
    const limit = this.cfg.get().settings?.logLimit ?? 200;
    if (limit <= 0) return;
    this.logs.unshift({
      id: ++this.logSeq,
      at: new Date().toISOString(),
      ...entry
    });
    if (this.logs.length > limit) {
      this.logs.length = limit;
    }
  }

  getLogs(limit = 200) {
    const cfgLimit = this.cfg.get().settings?.logLimit ?? 200;
    const cap = Math.min(Math.max(1, limit), Math.max(1, cfgLimit));
    return this.logs.slice(0, cap);
  }

  clearLogs() {
    this.logs.length = 0;
  }

  invalidate(id) {
    const r = this.states.get(id);
    this.states.delete(id);
    if (r) {
      r.invalid = true;
      void safeClose(r.client);
    }
  }

  async close() {
    clearInterval(this.reaper);
    await Promise.all(
      [...this.states.values()].map((r) => {
        r.invalid = true;
        return safeClose(r.client);
      })
    );
    this.states.clear();
  }

  async refresh(s, force = false, requireClient = false) {
    let r = this.states.get(s.id);
    if (r?.pending) return r.pending;
    const now = Date.now();
    if (!force && r) {
      // Circuit-breaker cooldown after repeated failures (avoids blocking search on dead upstreams)
      if (!requireClient && r.status === 'error' && r.cooldownUntil && now < r.cooldownUntil) {
        return r;
      }
      // Fresh cache hit (if caller doesn't need an active client process, hibernated snapshot is valid)
      if (now - r.at < 60_000 && (!requireClient || r.client)) {
        r.lastUsed = now;
        return r;
      }
      // Stale-while-revalidate: serve existing tool snapshot immediately while refreshing in background
      if (!requireClient && r.status === 'ready' && r.tools.length > 0) {
        r.lastUsed = now;
        const state = r;
        state.pending = this.load(s, state).finally(() => {
          state.pending = null;
        });
        return r;
      }
    }
    if (!r) {
      r = { tools: [], status: 'idle', at: 0, lastUsed: now, failures: 0, cooldownUntil: 0 };
      this.states.set(s.id, r);
    }
    const state = r;
    state.lastUsed = now;
    state.pending = this.load(s, state).finally(() => {
      state.pending = null;
    });
    return state.pending;
  }

  async refreshAll() {
    const enabled = this.cfg.get().servers.filter((s) => s.enabled);
    const results = await Promise.all(
      enabled.map(async (s) => {
        const r = await this.refresh(s, true);
        return { id: s.id, status: r.status, error: r.error || null, count: r.tools.length };
      })
    );
    return results;
  }

  async load(s, r) {
    const opts = { timeout: 12_000, signal: AbortSignal.timeout(12_000) };
    let error = 'Connection or MCP handshake failed.';
    let stderrTail = '';
    try {
      if (r.invalid) throw new Error();
      if (!r.client) {
        let transport;
        if (s.transport === 'stdio') {
          const env = Object.fromEntries(
            s.envKeys.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]])
          );
          transport = new StdioClientTransport({
            command: s.command,
            args: s.args,
            cwd: s.cwd || undefined,
            env,
            stderr: 'pipe'
          });
          transport.stderr?.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk.toString('utf8')).slice(-600);
          });
        } else {
          if (s.authMode === 'oauth') {
            if (!this.oauthStore?.hasTokens(s.id)) {
              error = 'OAuth sign-in required. Click OAuth Sign In in Connections.';
              throw new Error('');
            }
            const provider = this.oauthStore.createProvider(s.id);
            transport = httpClient(s.url, {}, provider, this.oauthStore.fetchFor(s.id));
          } else {
            if (s.bearerEnv && !process.env[s.bearerEnv]) {
              error = `Missing Bearer environment variable: ${s.bearerEnv}.`;
              throw new Error('');
            }
            transport = httpClient(
              s.url,
              s.bearerEnv ? { Authorization: 'Bearer ' + process.env[s.bearerEnv] } : {}
            );
          }
        }
        const c = newClient();
        r.client = c;
        c.onerror = () => {};
        c.onclose = () => {
          if (r.client === c) {
            r.client = null;
            r.at = 0;
          }
        };
        await c.connect(transport, opts);
      }
      error = '未能完整读取上游工具目录。';
      const c = r.client;
      const tools = [];
      const seen = new Set();
      const cursors = new Set();
      const engines = validators();
      let cursor;
      for (let i = 0; i < 20; i++) {
        const pageData = await c.listTools(cursor ? { cursor } : {}, opts);
        for (const t of pageData.tools) {
          if (
            !toolName.test(t.name) ||
            seen.has(t.name) ||
            !rec(t.inputSchema) ||
            jsz(t.inputSchema) > 48_000 ||
            tools.length >= 500
          ) {
            throw new Error('上游返回的工具定义超出限制或格式不合法');
          }
          seen.add(t.name);
          const dialect = String(t.inputSchema.$schema || '');
          const schema = { ...t.inputSchema };
          const engine = engines[dialect.includes('2020-12') ? 2 : dialect.includes('2019-09') ? 1 : 0];
          const schemaHash = createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 12);
          tools.push({
            name: t.name,
            title: text(t.title, 120) || undefined,
            icons: sanitizeIcons(t.icons),
            description: text(t.description, 2400),
            inputSchema: schema,
            schemaHash,
            outputSchema:
              rec(t.outputSchema) && jsz(t.outputSchema) <= 48_000 ? t.outputSchema : undefined,
            annotations: t.annotations,
            compile: () => engine.compile(schema)
          });
        }
        cursor = pageData.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || i === 19) throw new Error('工具分页游标重复或超过 20 页上限');
        cursors.add(cursor);
      }
      if (r.invalid) throw new Error();
      r.tools = tools;
      r.error = null;
      r.status = 'ready';
      r.hibernated = false;
      r.failures = 0;
      r.cooldownUntil = 0;
    } catch (err) {
      const c = r.client;
      r.client = null;
      r.tools = [];
      r.status = 'error';
      r.hibernated = false;
      r.failures = (r.failures || 0) + 1;
      const delay = BACKOFF_STEPS_MS[Math.min(r.failures - 1, BACKOFF_STEPS_MS.length - 1)];
      r.cooldownUntil = Date.now() + delay;
      r.error = diagnoseConnectError(err, error, stderrTail);
      await safeClose(c);
    } finally {
      r.at = Date.now();
    }
    return r;
  }

  view(s, t, detail = false) {
    const row = {
      tool_id: s.id + '/' + t.name,
      server_id: s.id,
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      ...(t.icons ? { icons: t.icons } : {}),
      description: Object.hasOwn(s.overrides, t.name) ? s.overrides[t.name] : t.description,
      annotations: t.annotations
    };
    return detail
      ? {
          ...row,
          inputSchema: t.inputSchema,
          outputSchema: t.outputSchema,
          schemaHash: t.schemaHash,
          schemaDrifted: this.isDrifted(s, t)
        }
      : row;
  }

  snapshot() {
    return this.cfg.get().servers.map((s) => {
      const r = this.states.get(s.id);
      return {
        ...s,
        status: s.enabled ? r?.status || 'idle' : 'disabled',
        error: s.enabled ? r?.error || null : null,
        oauthStatus: s.transport === 'http' && s.authMode === 'oauth' ? this.oauthStore?.getStatus(s.id) || 'required' : null,
        missingEnvKeys: missingEnvKeysFor(s),
        tools: r?.tools.map((t) => this.view(s, t, true)) || []
      };
    });
  }

  async scoped(id, profile = null) {
    await Promise.all(
      this.cfg
        .get()
        .servers.filter(
          (s) => s.enabled && s.allowlist.length && profileAllows(profile, s.id) && (!id || s.id === id)
        )
        .map((s) => this.refresh(s))
    );
    return this.cfg
      .get()
      .servers.filter((s) => s.enabled && profileAllows(profile, s.id) && (!id || s.id === id))
      .map((s) => [s, this.states.get(s.id)]);
  }

  async list({ server_id, offset = 0, limit = 20 }, profile = null) {
    const start = Date.now();
    const list = await this.scoped(server_id, profile);
    const out = {
      servers: list.slice(offset, offset + limit).map(([s, r]) => {
        const tools = r?.tools.filter((t) => this.isUsable(s, t)) || [];
        return {
          id: s.id,
          label: s.label,
          description: s.description,
          status: r?.status || 'idle',
          transport: s.transport,
          tool_count: tools.length,
          tools: tools.slice(0, 12).map((t) => s.id + '/' + t.name)
        };
      }),
      total: list.length,
      next_offset: offset + limit < list.length ? offset + limit : null
    };
    this.record({
      source: profile ? `profile:${profile.id}` : 'agent',
      action: 'list_mcps',
      target: server_id || '*',
      status: 'ok',
      durationMs: Date.now() - start,
      detail: `${out.servers.length} servers`
    });
    return out;
  }

  async search({ server_id, tool_id, query = '', offset = 0, limit = 5, include_schema = true }, profile = null) {
    const start = Date.now();
    const logSource = profile ? `profile:${profile.id}` : 'agent';
    const id = tool_id?.split('/')[0];
    if (id && server_id && server_id !== id) {
      this.record({
        source: logSource,
        action: 'search_tool',
        target: tool_id,
        status: 'ok',
        durationMs: Date.now() - start,
        detail: '0 matches'
      });
      return { matches: [], total: 0, next_offset: null };
    }
    const rows = await this.scoped(id || server_id, profile);
    if (id) {
      const [s, r] = rows[0] || [];
      const t = r?.tools.find((t) => this.isUsable(s, t) && s.id + '/' + t.name === tool_id);
      const out = {
        matches: t ? [this.view(s, t, true)] : [],
        total: t ? 1 : 0,
        next_offset: null,
        ...(t
          ? {
              how_to_call: `Call MCP Shelf call_tool with {"tool_id":"${tool_id}","arguments":{...}}. Do NOT invoke "${tool_id}" directly as a host tool.`
            }
          : {})
      };
      this.record({
        source: logSource,
        action: 'search_tool',
        target: tool_id,
        status: 'ok',
        durationMs: Date.now() - start,
        detail: t ? 'Exact schema returned' : 'Not found or not allowed'
      });
      return out;
    }
    const norm = (s) => s.trim().normalize('NFKC').toLowerCase();
    const q = norm(query);
    const terms = q.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).slice(0, 12);
    // Extract CJK bigrams for fuzzy Chinese/Japanese recall when multi-char CJK phrases don't match verbatim
    const cjkBigrams = [];
    for (const term of terms) {
      const cjkRuns = term.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu);
      if (cjkRuns) {
        for (const run of cjkRuns) {
          for (let i = 0; i < run.length - 1 && cjkBigrams.length < 16; i++) {
            cjkBigrams.push(run.slice(i, i + 2));
          }
        }
      }
    }
    const ranked = [];
    for (const [s, r] of rows) {
      for (const t of r?.tools || []) {
        if (!this.isUsable(s, t)) continue;
        const baseRow = this.view(s, t, false);
        const n = norm(baseRow.tool_id + ' ' + s.label + ' ' + (t.title || ''));
        const d = norm(baseRow.description + ' ' + s.description);
        let score = terms.length
          ? terms.reduce((a, b) => a + (n.includes(b) ? 8 : d.includes(b) ? 3 : 0), 0) +
            (n.includes(q) ? 10 : 0)
          : 1;
        if (score === 0 && cjkBigrams.length) {
          score = cjkBigrams.reduce((a, b) => a + (n.includes(b) ? 2 : d.includes(b) ? 1 : 0), 0);
        }
        if (score) ranked.push({ s, t, baseRow, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.baseRow.tool_id.localeCompare(b.baseRow.tool_id, 'en'));

    // Enforce a response schema byte budget so large upstream schemas don't bloat context
    let schemaBytes = 0;
    let schemasOmitted = 0;
    const matches = ranked.slice(offset, offset + limit).map(({ s, t, baseRow }) => {
      if (!include_schema) return baseRow;
      const detailed = this.view(s, t, true);
      const cost = jsz(detailed.inputSchema) + (detailed.outputSchema ? jsz(detailed.outputSchema) : 0);
      if (schemaBytes === 0 || schemaBytes + cost <= SEARCH_SCHEMA_BUDGET) {
        schemaBytes += cost;
        return detailed;
      }
      schemasOmitted++;
      return {
        ...baseRow,
        schema_omitted: true,
        required_params: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []
      };
    });

    const out = {
      matches,
      total: ranked.length,
      next_offset: offset + limit < ranked.length ? offset + limit : null,
      unavailable_servers: rows.filter(([, r]) => r?.status === 'error').map(([s]) => s.id),
      ...(schemasOmitted > 0
        ? {
            schema_budget_note: `${schemasOmitted} result(s) omitted full inputSchema to stay within the 16 KB context budget; call search_tool with exact tool_id to fetch.`
          }
        : {}),
      ...(matches.length
        ? {
            how_to_call: `Invoke matched tools through MCP Shelf call_tool with {"tool_id":"${matches[0].tool_id}","arguments":{...}}. Upstream tool_ids are proxied and cannot be called directly as host tools.`
          }
        : {})
    };
    this.record({
      source: logSource,
      action: 'search_tool',
      target: query || server_id || '*',
      status: 'ok',
      durationMs: Date.now() - start,
      detail: `${out.total} matches${include_schema ? ' (with schema)' : ''}`
    });
    return out;
  }

  async executeTool(
    { tool_id, arguments: a = {} },
    { signal, source = 'agent', requireAllowlist = true, profile = null, timeoutMs = 30_000 } = {}
  ) {
    const start = Date.now();
    const [id, n] = tool_id.split('/');
    const entry = () => this.cfg.get().servers.find((s) => s.id === id);
    const profileStillAllows = () => {
      if (!profile) return true;
      const current = this.cfg.get().profiles.find((pr) => pr.id === profile.id && pr.token === profile.token);
      return current !== undefined && profileAllows(current, id);
    };
    const s = entry();
    const allowed = profileStillAllows();
    if (!s?.enabled || !allowed || (requireAllowlist && !s.allowlist.includes(n))) {
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: 'blocked',
        durationMs: Date.now() - start,
        detail: !allowed
          ? 'Server not allowed for this access profile'
          : !s?.enabled
            ? 'Connection disabled or not found'
            : 'Tool not in allowlist'
      });
      return blocked();
    }
    if (this.calls >= 12) {
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: 'error',
        durationMs: Date.now() - start,
        detail: 'Gateway concurrency limit reached (12)'
      });
      return answer('Gateway capacity reached.', true);
    }
    const withDetails = () => this.cfg.get().settings?.logDetails === true;
    const argsPreview = withDetails() ? previewJson(a) : undefined;
    this.calls++;
    try {
      const r = await this.refresh(s, false, true);
      const curr = entry();
      if (
        !curr?.enabled ||
        !profileStillAllows() ||
        (requireAllowlist && !curr.allowlist.includes(n)) ||
        r.invalid ||
        signal?.aborted ||
        !r.client
      ) {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'blocked',
          durationMs: Date.now() - start,
          detail: r.error || 'Upstream unavailable or approval changed',
          ...(argsPreview ? { argsPreview } : {})
        });
        return blocked();
      }
      const t = r.tools.find((x) => x.name === n);
      if (!t) {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'blocked',
          durationMs: Date.now() - start,
          detail: 'Tool not found in upstream catalog',
          ...(argsPreview ? { argsPreview } : {})
        });
        return blocked();
      }
      if (requireAllowlist && this.cfg.get().settings?.strictSchemaDrift !== false && this.isDrifted(curr, t)) {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'blocked',
          durationMs: Date.now() - start,
          detail: 'Schema drift detected; re-approve in workbench',
          ...(argsPreview ? { argsPreview } : {})
        });
        return answer(
          `Tool "${tool_id}" was blocked because its upstream inputSchema changed since approval. Re-approve it in MCP Shelf Tool Catalog.`,
          true
        );
      }
      let v;
      try {
        v = t.validator ??= t.compile();
        if (!v(a)) {
          const e = v.errors[0];
          const reason = 'Arguments do not match inputSchema: ' + (e.instancePath || '/') + ' ' + e.message;
          this.record({
            source,
            action: 'call_tool',
            target: tool_id,
            status: 'invalid',
            durationMs: Date.now() - start,
            detail: cleanMsg(reason, 140),
            ...(argsPreview ? { argsPreview } : {})
          });
          return answer(reason, true);
        }
      } catch {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'error',
          durationMs: Date.now() - start,
          detail: 'Could not compile upstream inputSchema'
        });
        return answer('Could not validate upstream input schema. Call was not forwarded.', true);
      }
      const result = await r.client.callTool({ name: n, arguments: a }, undefined, { signal, timeout: timeoutMs });
      r.lastUsed = Date.now();
      if (jsz(result) > 512_000) {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'error',
          durationMs: Date.now() - start,
          detail: 'Output exceeded 512 KB limit',
          ...(argsPreview ? { argsPreview } : {})
        });
        return answer('Output exceeded 512 KB. Upstream was called; verify state before retrying.', true);
      }
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: result.isError ? 'upstream_error' : 'ok',
        durationMs: Date.now() - start,
        detail: result.isError ? 'Upstream returned isError' : 'OK',
        ...(argsPreview ? { argsPreview } : {}),
        ...(withDetails() ? { resultPreview: previewJson(result.structuredContent ?? result.content ?? result) } : {})
      });
      return result;
    } catch (err) {
      const reason = cleanMsg(err?.message, 120);
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: 'error',
        durationMs: Date.now() - start,
        detail: reason || 'Upstream call failed or timed out',
        ...(argsPreview ? { argsPreview } : {})
      });
      const suffix = reason ? ` (${reason})` : '';
      return answer(
        `Upstream call failed or timed out${suffix}. It may have executed; verify state before retrying.`,
        true
      );
    } finally {
      this.calls--;
    }
  }

  call(params, extra, profile = null, timeoutMs = 30_000) {
    return this.executeTool(params, {
      signal: extra?.signal,
      source: profile ? `profile:${profile.id}` : 'agent',
      requireAllowlist: true,
      profile,
      timeoutMs
    });
  }

  testCall(params, signal) {
    return this.executeTool(params, { signal, source: 'playground', requireAllowlist: false });
  }
}
