import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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
  const { id = APP_NAME, instructions, listChanged = false } =
    typeof opts === 'string' ? { id: opts } : opts || {};
  const serverOpts = {
    capabilities: { tools: listChanged ? { listChanged: true } : {} },
    ...(instructions ? { instructions } : {})
  };
  const s = new Server({ name: id, version: APP_VERSION }, serverOpts);
  s.setRequestHandler(ListToolsRequestSchema, (r, e) => list(r, e));
  s.setRequestHandler(CallToolRequestSchema, (r, e) => call(r.params, e));
  return s;
};

export const newClient = () => new Client({ name: APP_NAME, version: APP_VERSION });

export const httpClient = (url, headers = {}) =>
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    fetch: (i, o) => fetch(i, { ...o, redirect: 'error' })
  });

const allowed = (s, t) => s.allowlist.includes(t.name);
const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const cleanMsg = (s, max = 180) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function diagnoseConnectError(err, fallback, stderrTail = '') {
  const code = err?.code || err?.cause?.code;
  const msg = cleanMsg(err?.message);
  if (code === 'ENOENT') return `${fallback}（找不到可执行文件）`;
  if (code === 'EACCES') return `${fallback}（可执行文件无执行权限）`;
  if (code === 'ECONNREFUSED') return `${fallback}（目标端点拒绝连接）`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed?\s*out/i.test(msg)) {
    return `${fallback}（连接或握手超时）`;
  }
  const httpCode = /\b(401|403|404|405|500|502|503)\b/.exec(msg);
  if (httpCode) return `${fallback}（HTTP ${httpCode[1]}）`;
  const tail = cleanMsg(stderrTail, 140);
  if (tail) return `${fallback}（${tail}）`;
  if (msg && msg !== 'Error') return `${fallback}（${msg}）`;
  return fallback;
}

function missingEnvKeysFor(s) {
  if (s.transport === 'stdio') {
    return (s.envKeys || []).filter((k) => process.env[k] == null || process.env[k] === '');
  }
  if (s.transport === 'http' && s.bearerEnv && !process.env[s.bearerEnv]) {
    return [s.bearerEnv];
  }
  return [];
}

const MAX_LOGS = 200;

export class Catalog {
  constructor(cfg) {
    this.cfg = cfg;
    this.states = new Map();
    this.calls = 0;
    this.logs = [];
    this.logSeq = 0;
    this.listeners = new Set();
    this.lastFingerprint = this.fingerprint();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  fingerprint() {
    const c = this.cfg.get();
    const summary = {
      descriptions: c.descriptions,
      servers: c.servers
        .filter((s) => s.enabled)
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
   * Compact Grok-Build-style server summary listing enabled servers that have approved tools.
   * Deliberately omits raw tool lists to keep prompt footprint tiny while letting agents know
   * which integrations exist upfront.
   */
  serverReminder() {
    const active = this.cfg
      .get()
      .servers.filter((s) => s.enabled && s.allowlist.length > 0);
    if (!active.length) return '';
    const lines = ['Connected MCP servers:'];
    for (const s of active) {
      const r = this.states.get(s.id);
      const count = r?.status === 'ready'
        ? r.tools.filter((t) => allowed(s, t)).length
        : s.allowlist.length;
      const word = count === 1 ? 'tool' : 'tools';
      const desc = cleanMsg(s.description || (s.label !== s.id ? s.label : ''), 160);
      lines.push(desc ? `- ${s.id} (${count} ${word}): ${desc}` : `- ${s.id} (${count} ${word})`);
    }
    return lines.join('\n');
  }

  metaInstructions() {
    const reminder = this.serverReminder();
    const usage =
      'Upstream tools behind MCP Shelf are proxied and NOT registered directly on the host. Always discover them with MCP Shelf `search_tool` and invoke them via MCP Shelf `call_tool({ tool_id, arguments })`. Never call `server/tool` or `server__tool` directly on the host.';
    return reminder ? `${reminder}\n\n${usage}` : usage;
  }

  metaTools(descs = this.cfg.get().descriptions) {
    const reminder = this.serverReminder();
    return meta.map((t) => {
      const base = descs[t.name];
      const description = reminder ? `${base}\n\n${reminder}` : base;
      return { ...t, description };
    });
  }

  record(entry) {
    this.logs.unshift({
      id: ++this.logSeq,
      at: new Date().toISOString(),
      ...entry
    });
    if (this.logs.length > MAX_LOGS) {
      this.logs.length = MAX_LOGS;
    }
  }

  getLogs(limit = 100) {
    return this.logs.slice(0, Math.min(Math.max(1, limit), MAX_LOGS));
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
    await Promise.all(
      [...this.states.values()].map((r) => {
        r.invalid = true;
        return safeClose(r.client);
      })
    );
    this.states.clear();
  }

  async refresh(s, force = false) {
    let r = this.states.get(s.id);
    if (r?.pending) return r.pending;
    if (!force && r && Date.now() - r.at < 60_000) return r;
    if (!r) {
      r = { tools: [], status: 'idle', at: 0 };
      this.states.set(s.id, r);
    }
    const state = r;
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
    let error = '连接或 MCP 握手失败。';
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
          if (s.bearerEnv && !process.env[s.bearerEnv]) {
            error = `缺少上游 Bearer 环境变量：${s.bearerEnv}。`;
            throw new Error('');
          }
          transport = httpClient(
            s.url,
            s.bearerEnv ? { Authorization: 'Bearer ' + process.env[s.bearerEnv] } : {}
          );
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
    } catch (err) {
      const c = r.client;
      r.client = null;
      r.tools = [];
      r.status = 'error';
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
      description: Object.hasOwn(s.overrides, t.name) ? s.overrides[t.name] : t.description,
      annotations: t.annotations
    };
    return detail
      ? { ...row, inputSchema: t.inputSchema, outputSchema: t.outputSchema, schemaHash: t.schemaHash }
      : row;
  }

  snapshot() {
    return this.cfg.get().servers.map((s) => {
      const r = this.states.get(s.id);
      return {
        ...s,
        status: s.enabled ? r?.status || 'idle' : 'disabled',
        error: s.enabled ? r?.error || null : null,
        missingEnvKeys: missingEnvKeysFor(s),
        tools: r?.tools.map((t) => this.view(s, t, true)) || []
      };
    });
  }

  async scoped(id) {
    await Promise.all(
      this.cfg
        .get()
        .servers.filter((s) => s.enabled && s.allowlist.length && (!id || s.id === id))
        .map((s) => this.refresh(s))
    );
    return this.cfg
      .get()
      .servers.filter((s) => s.enabled && (!id || s.id === id))
      .map((s) => [s, this.states.get(s.id)]);
  }

  async list({ server_id, offset = 0, limit = 20 }) {
    const start = Date.now();
    const list = await this.scoped(server_id);
    const out = {
      servers: list.slice(offset, offset + limit).map(([s, r]) => {
        const tools = r?.tools.filter((t) => allowed(s, t)) || [];
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
      source: 'agent',
      action: 'list_mcps',
      target: server_id || '*',
      status: 'ok',
      durationMs: Date.now() - start,
      detail: `${out.servers.length} 个连接`
    });
    return out;
  }

  async search({ server_id, tool_id, query = '', offset = 0, limit = 5, include_schema = true }) {
    const start = Date.now();
    const id = tool_id?.split('/')[0];
    if (id && server_id && server_id !== id) {
      this.record({
        source: 'agent',
        action: 'search_tool',
        target: tool_id,
        status: 'ok',
        durationMs: Date.now() - start,
        detail: '0 条匹配'
      });
      return { matches: [], total: 0, next_offset: null };
    }
    const rows = await this.scoped(id || server_id);
    if (id) {
      const [s, r] = rows[0] || [];
      const t = r?.tools.find((t) => allowed(s, t) && s.id + '/' + t.name === tool_id);
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
        source: 'agent',
        action: 'search_tool',
        target: tool_id,
        status: 'ok',
        durationMs: Date.now() - start,
        detail: t ? '返回精确 Schema' : '未找到或未开放'
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
        if (!allowed(s, t)) continue;
        const row = this.view(s, t, include_schema);
        const n = norm(row.tool_id + ' ' + s.label);
        const d = norm(row.description + ' ' + s.description);
        let score = terms.length
          ? terms.reduce((a, b) => a + (n.includes(b) ? 8 : d.includes(b) ? 3 : 0), 0) +
            (n.includes(q) ? 10 : 0)
          : 1;
        if (score === 0 && cjkBigrams.length) {
          score = cjkBigrams.reduce((a, b) => a + (n.includes(b) ? 2 : d.includes(b) ? 1 : 0), 0);
        }
        if (score) ranked.push({ row, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.row.tool_id.localeCompare(b.row.tool_id, 'en'));
    const matches = ranked.slice(offset, offset + limit).map((x) => x.row);
    const out = {
      matches,
      total: ranked.length,
      next_offset: offset + limit < ranked.length ? offset + limit : null,
      unavailable_servers: rows.filter(([, r]) => r?.status === 'error').map(([s]) => s.id),
      ...(matches.length
        ? {
            how_to_call: `Invoke matched tools through MCP Shelf call_tool with {"tool_id":"${matches[0].tool_id}","arguments":{...}}. Upstream tool_ids are proxied and cannot be called directly as host tools.`
          }
        : {})
    };
    this.record({
      source: 'agent',
      action: 'search_tool',
      target: query || server_id || '*',
      status: 'ok',
      durationMs: Date.now() - start,
      detail: `${out.total} 条匹配${include_schema ? '（含 Schema）' : ''}`
    });
    return out;
  }

  async executeTool({ tool_id, arguments: a = {} }, { signal, source = 'agent', requireAllowlist = true } = {}) {
    const start = Date.now();
    const [id, n] = tool_id.split('/');
    const entry = () => this.cfg.get().servers.find((s) => s.id === id);
    const s = entry();
    if (!s?.enabled || (requireAllowlist && !s.allowlist.includes(n))) {
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: 'blocked',
        durationMs: Date.now() - start,
        detail: !s?.enabled ? '连接未启用或不存在' : '工具未在白名单中'
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
        detail: '并发调用已达上限 (12)'
      });
      return answer('Gateway capacity reached.', true);
    }
    this.calls++;
    try {
      const r = await this.refresh(s);
      const curr = entry();
      if (
        !curr?.enabled ||
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
          detail: r.error || '上游连接不可用或授权已变更'
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
          detail: '上游目录中无此工具'
        });
        return blocked();
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
            detail: cleanMsg(reason, 140)
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
          detail: '无法编译上游 inputSchema'
        });
        return answer('Could not validate upstream input schema. Call was not forwarded.', true);
      }
      const result = await r.client.callTool({ name: n, arguments: a }, undefined, { signal, timeout: 30_000 });
      if (jsz(result) > 512_000) {
        this.record({
          source,
          action: 'call_tool',
          target: tool_id,
          status: 'error',
          durationMs: Date.now() - start,
          detail: '回包超过 512 KB 上限'
        });
        return answer('Output exceeded 512 KB. Upstream was called; verify state before retrying.', true);
      }
      this.record({
        source,
        action: 'call_tool',
        target: tool_id,
        status: result.isError ? 'upstream_error' : 'ok',
        durationMs: Date.now() - start,
        detail: result.isError ? '上游返回 isError' : '调用成功'
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
        detail: reason || '上游调用失败或超时'
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

  call(params, extra) {
    return this.executeTool(params, { signal: extra?.signal, source: 'agent', requireAllowlist: true });
  }

  testCall(params, signal) {
    return this.executeTool(params, { signal, source: 'playground', requireAllowlist: false });
  }
}
