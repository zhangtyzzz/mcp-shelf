import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'mcp-shelf';
export const APP_VERSION = '0.4.0';
export const DEFAULT_PORT = 8787;
export const CLI_PATH = fileURLToPath(new URL('./main.mjs', import.meta.url));
export const DEFAULT_DIR = () => path.join(os.homedir(), '.config', APP_NAME);
export const dirFromEnv = () => path.resolve(process.env.MCP_SHELF_HOME || DEFAULT_DIR());

export function portFromEnv() {
  const n = Number(process.env.MCP_SHELF_PORT || DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('Invalid MCP_SHELF_PORT');
  }
  return n;
}

export function modeFromEnv() {
  const m = String(process.env.MCP_SHELF_MODE || 'local').trim().toLowerCase();
  if (!['local', 'remote'].includes(m)) {
    throw new Error('Invalid MCP_SHELF_MODE (expected "local" or "remote")');
  }
  return m;
}

export function hostFromEnv(mode = modeFromEnv()) {
  const h = String(process.env.MCP_SHELF_HOST || '').trim();
  if (h) return h;
  return mode === 'remote' ? '0.0.0.0' : '127.0.0.1';
}

export function publicUrlFromEnv() {
  const raw = String(process.env.MCP_SHELF_PUBLIC_URL || '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid MCP_SHELF_PUBLIC_URL');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
    throw new Error('MCP_SHELF_PUBLIC_URL must be a clean http(s) origin without credentials or query.');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export const adminPasswordFromEnv = () => String(process.env.MCP_SHELF_ADMIN_PASSWORD || '');

export const rec = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const serverId = /^[a-z][a-z0-9_-]{0,47}$/;
export const toolName = /^[A-Za-z0-9_.-]{1,128}$/;
export const envName = /^(?!(?:constructor|prototype|__proto__)$)[A-Za-z_][A-Za-z0-9_]*$/;
export const toolId = /^[a-z][a-z0-9_-]{0,47}\/[A-Za-z0-9_.-]{1,128}$/;

export const token = () => randomBytes(32).toString('hex');
export const jsz = (x) => Buffer.byteLength(JSON.stringify(x));
export const same = (a, b) =>
  typeof a === 'string' &&
  a.length === b.length &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

export const limited = (x, label, n, required = false) => {
  if (x === undefined && !required) return '';
  if (typeof x !== 'string' || x.length > n || x.includes('\0') || (required && !x.trim())) {
    throw fail('无效字段：' + label);
  }
  return x.trim();
};

export const array = (a, check, label, n) => {
  if (a === undefined) return [];
  if (!Array.isArray(a) || a.length > n || a.some((x) => typeof x !== 'string' || !check(x))) {
    throw fail('无效字段：' + label);
  }
  return a;
};

export const defaults = {
  list_mcps:
    'List enabled upstream MCP servers and a preview of approved tools. Use search_tool to discover tools and fetch their input schemas.',
  search_tool:
    'Search approved upstream MCP tools by keyword or exact tool_id. Returns matching tools with their full inputSchema by default (pass include_schema=false for compact names only) so you can call them directly via call_tool.',
  call_tool:
    'Call one approved tool by its exact tool_id and JSON arguments matching the inputSchema returned by search_tool. Never guess parameter names. This can change real state; obtain needed user approval first and never blindly retry a failed write.'
};

export function descriptions(v) {
  if (!rec(v)) throw fail('无效的描述设置');
  return Object.fromEntries(
    Object.entries(defaults).map(([k, d]) => [k, limited(v[k], k, 2400) || d])
  );
}

export function source(v) {
  if (!rec(v) || typeof v.id !== 'string' || !serverId.test(v.id)) {
    throw fail('连接 ID 需要小写字母开头，只能含小写字母、数字、横线和下划线。');
  }
  const overrides = Object.create(null);
  const raw = v.overrides ?? {};
  if (!rec(raw) || Object.keys(raw).length > 500) {
    throw fail('无效的工具描述');
  }
  for (const [k, val] of Object.entries(raw)) {
    if (!toolName.test(k)) throw fail('无效的工具名');
    const d = limited(val, k, 2400);
    if (d) overrides[k] = d;
  }
  const common = {
    id: v.id,
    label: limited(v.label, '显示名', 100) || v.id,
    description: limited(v.description, '描述', 1000),
    transport: v.transport,
    enabled: v.enabled === true,
    allowlist: [...new Set(array(v.allowlist, (x) => toolName.test(x), '白名单', 500))],
    overrides
  };
  if (v.transport === 'stdio') {
    const command = limited(v.command, '可执行文件', 1000, true);
    const cwd = limited(v.cwd, '工作目录', 1500);
    if (/[\r\n]/.test(command) || (cwd && !path.isAbsolute(cwd))) {
      throw fail('可执行文件须为单个命令，工作目录须为绝对路径。');
    }
    return {
      ...common,
      command,
      cwd,
      args: array(v.args, (x) => x.length <= 4096 && !x.includes('\0'), '参数', 100),
      envKeys: [...new Set(array(v.envKeys, (x) => envName.test(x), '环境变量名', 50))]
    };
  }
  if (v.transport !== 'http') {
    throw fail('选择 stdio 或 Streamable HTTP。');
  }
  let u;
  try {
    u = new URL(limited(v.url, 'URL', 1800, true));
  } catch {
    throw fail('无效的 MCP URL。');
  }
  const allowedHttp =
    u.protocol === 'https:' ||
    (u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname));
  if (u.username || u.password || u.search || u.hash || !allowedHttp) {
    throw fail('使用 HTTPS 或回环 HTTP，URL 不含凭据、查询或片段。');
  }
  const bearerEnv = limited(v.bearerEnv, 'Bearer 变量名', 100);
  if (bearerEnv && !envName.test(bearerEnv)) {
    throw fail('无效的 Bearer 环境变量名。');
  }
  return { ...common, url: u.href, bearerEnv };
}

export const signature = (s) =>
  JSON.stringify([s.transport, s.command, s.cwd, s.args, s.envKeys, s.url, s.bearerEnv]);

export const demoSource = (allowlist) =>
  source({
    id: 'demo',
    label: '本地示例',
    description: '离线回显和加法，不访问外网。',
    transport: 'stdio',
    command: process.execPath,
    args: [CLI_PATH, 'demo-upstream'],
    enabled: true,
    allowlist
  });

export function openConfig(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, token: token(), descriptions: defaults, servers: [] }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    raw.version !== 1 ||
    !/^[0-9a-f]{64}$/.test(raw.token || '') ||
    !Array.isArray(raw.servers) ||
    raw.servers.length > 40
  ) {
    throw new Error('Invalid gateway config.');
  }
  let cfg = {
    ...raw,
    descriptions: descriptions(raw.descriptions),
    servers: raw.servers.map(source)
  };
  if (new Set(cfg.servers.map((s) => s.id)).size !== cfg.servers.length) {
    throw new Error('Duplicate connection IDs.');
  }
  return {
    file,
    dir,
    get: () => cfg,
    save(next) {
      const temp = path.join(dir, '.save-' + token());
      try {
        fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, file);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
      cfg = next;
    }
  };
}

function normalizeId(rawId) {
  let id = String(rawId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id || !/^[a-z]/.test(id)) id = 'mcp-' + id;
  return id.slice(0, 48);
}

function parseTomlValue(raw) {
  const s = raw.trim();
  if (!s) return undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') || s.startsWith('[')) {
    return JSON.parse(s);
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

function parseCodexToml(text) {
  const servers = {};
  let currentId = null;
  let inEnv = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*#.*$/, '').trim();
    if (!line) continue;
    const secMatch = /^\[mcp_servers\.([A-Za-z0-9_-]+)(?:\.(env))?\]$/.exec(line);
    if (secMatch) {
      currentId = secMatch[1];
      inEnv = secMatch[2] === 'env';
      servers[currentId] ??= { env: {} };
      continue;
    }
    if (line.startsWith('[')) {
      currentId = null;
      inEnv = false;
      continue;
    }
    if (!currentId) continue;
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, valStr] = kv;
    const cleaned = valStr.replace(/\s+#.*$/, '').trim();
    try {
      const val = parseTomlValue(cleaned);
      if (inEnv) {
        servers[currentId].env[key] = String(val ?? '');
      } else {
        servers[currentId][key] = val;
      }
    } catch {
      // Ignore unparseable optional TOML fields (e.g. timeouts)
    }
  }
  return servers;
}

/**
 * Parse pasted Claude/Antigravity/Cursor JSON (`mcpServers`) or Codex TOML (`[mcp_servers.*]`)
 * into validated MCP Shelf connection candidates. Secret env values are never stored.
 */
export function parseImportConfig(rawText) {
  const input = limited(rawText, '导入内容', 200_000, true);
  let entries;
  let format;

  if (/^\[mcp_servers\./m.test(input)) {
    entries = parseCodexToml(input);
    format = 'toml';
  } else if (input.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw fail('JSON 格式无效，请检查括号与引号。');
    }
    if (rec(parsed) && rec(parsed.mcpServers)) {
      entries = parsed.mcpServers;
      format = 'json';
    } else if (rec(parsed) && (typeof parsed.command === 'string' || typeof parsed.url === 'string')) {
      entries = { [parsed.id || 'imported']: parsed };
      format = 'json';
    } else if (rec(parsed)) {
      entries = parsed;
      format = 'json';
    } else {
      throw fail('未找到可识别的 mcpServers 配置对象。');
    }
  } else {
    throw fail('支持粘贴 mcpServers JSON 或 Codex config.toml 的 [mcp_servers.*] 片段。');
  }

  const items = [];
  const skipped = [];
  const seen = new Set();

  for (const [rawKey, cfg] of Object.entries(entries)) {
    if (!rec(cfg)) {
      skipped.push({ id: rawKey, reason: '配置项不是对象' });
      continue;
    }
    const id = normalizeId(cfg.id || rawKey);
    if (id === 'mcp-shelf' || id === 'mcp_shelf') {
      skipped.push({ id: rawKey, reason: '跳过 MCP Shelf 自身，避免递归环路' });
      continue;
    }
    if (seen.has(id)) {
      skipped.push({ id: rawKey, reason: `规范化后的 ID (${id}) 重复` });
      continue;
    }

    const warnings = [];
    const candidate = {
      id,
      label: typeof cfg.label === 'string' && cfg.label.trim() ? cfg.label.trim() : rawKey,
      description: typeof cfg.description === 'string' ? cfg.description : '',
      enabled: cfg.enabled === false || cfg.disabled === true ? false : true,
      allowlist: []
    };

    if (typeof cfg.command === 'string' && cfg.command.trim()) {
      candidate.transport = 'stdio';
      candidate.command = cfg.command.trim();
      candidate.args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      candidate.cwd = typeof cfg.cwd === 'string' ? cfg.cwd : '';
      const envKeys = [];
      if (Array.isArray(cfg.envKeys)) {
        envKeys.push(...cfg.envKeys);
      }
      if (rec(cfg.env)) {
        const keys = Object.keys(cfg.env).filter((k) => envName.test(k));
        if (keys.length) {
          envKeys.push(...keys);
          warnings.push(`仅导入环境变量名 (${keys.join(', ')})，未保存明文值，请在启动网关的环境中设置。`);
        }
      }
      candidate.envKeys = [...new Set(envKeys)];
    } else if (typeof cfg.url === 'string' && cfg.url.trim()) {
      candidate.transport = 'http';
      candidate.url = cfg.url.trim();
      candidate.bearerEnv =
        typeof cfg.bearerEnv === 'string'
          ? cfg.bearerEnv
          : typeof cfg.bearer_token_env_var === 'string'
            ? cfg.bearer_token_env_var
            : '';
      if (rec(cfg.headers) && Object.keys(cfg.headers).length && !candidate.bearerEnv) {
        warnings.push('检测到自定义 headers，未导入明文凭据；如需认证请配置 Bearer 环境变量名。');
      }
    } else {
      skipped.push({ id: rawKey, reason: '缺少 command 或 url' });
      continue;
    }

    try {
      const validated = source(candidate);
      seen.add(id);
      items.push({ server: validated, warnings });
    } catch (err) {
      skipped.push({ id: rawKey, reason: err.message });
    }
  }

  return { format, items, skipped };
}
