import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

export const APP_NAME = 'mcp-shelf';
export const APP_VERSION = '0.8.6';
const CONFIG_VERSION = 2;
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

export function oauthAccessTtlSecondsFromEnv() {
  const raw = String(process.env.MCP_SHELF_OAUTH_ACCESS_TTL_SECONDS ?? '86400').trim();
  const ttl = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(ttl) || ttl > 2_592_000) {
    throw new Error('MCP_SHELF_OAUTH_ACCESS_TTL_SECONDS must be an integer from 1 to 2592000.');
  }
  return ttl;
}

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
    'List enabled upstream MCP servers proxied by MCP Shelf and a preview of approved tools. Use MCP Shelf search_tool to discover tools and MCP Shelf call_tool to invoke them.',
  search_tool:
    'Search approved upstream MCP tools proxied by MCP Shelf by keyword or exact tool_id. Returns matching tools with their full inputSchema by default (pass include_schema=false for compact names only). Important: returned tool_ids (like "context7/query-docs") are NOT host tools — always invoke them through MCP Shelf call_tool({ tool_id, arguments }).',
  call_tool:
    'Proxy-invoke one approved upstream tool behind MCP Shelf using { tool_id, arguments } where tool_id is the exact "server/tool" ID and arguments match the inputSchema returned by MCP Shelf search_tool. Never guess parameter names. Obtain needed user approval for writes and never blindly retry a failed write.'
};

export const defaultSettings = {
  logLimit: 200,
  logDetails: false,
  idleMinutes: 10,
  strictSchemaDrift: true
};

export function normalizeSettings(v) {
  if (v === undefined || v === null) return { ...defaultSettings };
  if (!rec(v)) throw fail('Invalid settings object.');
  const logLimit = v.logLimit === undefined ? defaultSettings.logLimit : Number(v.logLimit);
  if (!Number.isInteger(logLimit) || logLimit < 0 || logLimit > 2000) {
    throw fail('logLimit must be an integer between 0 and 2000.');
  }
  const idleMinutes = v.idleMinutes === undefined ? defaultSettings.idleMinutes : Number(v.idleMinutes);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 0 || idleMinutes > 1440) {
    throw fail('idleMinutes must be an integer between 0 and 1440.');
  }
  const logDetails = v.logDetails === undefined ? defaultSettings.logDetails : Boolean(v.logDetails);
  const strictSchemaDrift =
    v.strictSchemaDrift === undefined ? defaultSettings.strictSchemaDrift : Boolean(v.strictSchemaDrift);
  return { logLimit, logDetails, idleMinutes, strictSchemaDrift };
}

export function descriptions(v) {
  if (!rec(v)) throw fail('无效的描述设置');
  return Object.fromEntries(
    Object.entries(defaults).map(([k, d]) => [k, limited(v[k], k, 2400) || d])
  );
}

const BLOCKED_ENV_NAMES = /^(?:MCP_SHELF_|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_)/;
const isAllowedEnvName = (x) => envName.test(x) && !BLOCKED_ENV_NAMES.test(x);

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
  const approvedHashes = Object.create(null);
  const rawHashes = v.approvedHashes ?? {};
  if (!rec(rawHashes) || Object.keys(rawHashes).length > 500) {
    throw fail('Invalid approvedHashes map.');
  }
  for (const [k, val] of Object.entries(rawHashes)) {
    if (!toolName.test(k)) throw fail('Invalid tool name in approvedHashes.');
    if (typeof val === 'string' && /^[0-9a-f]{12}$/.test(val)) {
      approvedHashes[k] = val;
    }
  }
  const allowlist = [...new Set(array(v.allowlist, (x) => toolName.test(x), '白名单', 500))];
  // Keep approvedHashes pruned to tools currently in allowlist
  for (const k of Object.keys(approvedHashes)) {
    if (!allowlist.includes(k)) delete approvedHashes[k];
  }
  const common = {
    id: v.id,
    label: limited(v.label, '显示名', 100) || v.id,
    description: limited(v.description, '描述', 1000),
    transport: v.transport,
    enabled: v.enabled === true,
    allowlist,
    approvedHashes,
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
      envKeys: [...new Set(array(v.envKeys, isAllowedEnvName, '环境变量名', 50))]
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
  if (bearerEnv && !isAllowedEnvName(bearerEnv)) {
    throw fail('无效或受保护的 Bearer 环境变量名。');
  }
  const rawMode = v.authMode;
  const authMode =
    rawMode === 'oauth'
      ? 'oauth'
      : rawMode === 'bearer' || (!rawMode && bearerEnv)
        ? 'bearer'
        : 'none';
  return { ...common, url: u.href, authMode, bearerEnv: authMode === 'bearer' ? bearerEnv : '' };
}

export const signature = (s) =>
  JSON.stringify([s.transport, s.command, s.cwd, s.args, s.envKeys, s.url, s.authMode, s.bearerEnv]);

export function profile(v) {
  if (!rec(v) || typeof v.id !== 'string' || !serverId.test(v.id)) {
    throw fail('Profile ID must start with a lowercase letter and contain only a-z, 0-9, -, _.');
  }
  if (v.scope !== 'all' && v.scope !== 'selected') {
    throw fail('Profile scope must be "all" or "selected".');
  }
  const servers = [...new Set(array(v.servers, (x) => serverId.test(x), 'Profile servers', 40))];
  const tok = typeof v.token === 'string' && /^[0-9a-f]{64}$/.test(v.token) ? v.token : token();
  return {
    id: v.id,
    label: limited(v.label, 'Profile label', 100) || v.id,
    description: limited(v.description, 'Profile description', 400),
    token: tok,
    scope: v.scope,
    servers: v.scope === 'all' ? [] : servers
  };
}

export const BUILTIN_TEMPLATES = [
  {
    id: 'exa',
    label: 'Exa Search (Free)',
    description: 'Free hosted Exa web search & code context MCP (no API key required).',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    authMode: 'none',
    bearerEnv: '',
    enabled: true
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date documentation and code examples for libraries and frameworks.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    envKeys: [],
    enabled: true
  },
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Dynamic structured reasoning and step-by-step problem breakdown.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envKeys: [],
    enabled: true
  },
  {
    id: 'filesystem',
    label: 'Local Filesystem',
    description: 'Read and inspect files inside an allowed local directory (edit path before saving).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/workspace'],
    envKeys: [],
    enabled: true
  },
  {
    id: 'playwright',
    label: 'Playwright Browser',
    description: 'Headless/headed browser automation and webpage inspection via Playwright.',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    envKeys: [],
    enabled: true
  },
  {
    id: 'github',
    label: 'GitHub (Remote OAuth)',
    description: 'Official remote GitHub MCP server using OAuth 2.1 browser sign-in.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    authMode: 'oauth',
    bearerEnv: '',
    enabled: true
  }
];

export const demoSource = (allowlist) =>
  source({
    id: 'demo',
    label: 'Local Demo',
    description: 'Offline echo and add tools for local verification.',
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
      JSON.stringify(
        {
          version: CONFIG_VERSION,
          token: token(),
          descriptions: defaults,
          settings: defaultSettings,
          profiles: [],
          servers: []
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    (raw.version !== 1 && raw.version !== CONFIG_VERSION) ||
    !/^[0-9a-f]{64}$/.test(raw.token || '') ||
    !Array.isArray(raw.servers) ||
    raw.servers.length > 40
  ) {
    throw new Error('Invalid gateway config.');
  }
  const rawProfiles = raw.profiles === undefined ? [] : raw.profiles;
  if (!Array.isArray(rawProfiles) || rawProfiles.length > 30) {
    throw new Error('Invalid profiles in gateway config.');
  }
  let cfg = {
    ...raw,
    version: CONFIG_VERSION,
    descriptions: descriptions(raw.descriptions),
    settings: normalizeSettings(raw.settings),
    profiles: rawProfiles.map((entry) => {
      if (raw.version === 1 && rec(entry)) {
        const legacyServers = array(entry.servers, (x) => serverId.test(x), 'Profile servers', 40);
        return profile({ ...entry, scope: legacyServers.length ? 'selected' : 'all' });
      }
      return profile(entry);
    }),
    servers: raw.servers.map(source)
  };
  if (new Set(cfg.servers.map((s) => s.id)).size !== cfg.servers.length) {
    throw new Error('Duplicate connection IDs.');
  }
  if (new Set(cfg.profiles.map((p) => p.id)).size !== cfg.profiles.length) {
    throw new Error('Duplicate profile IDs.');
  }
  const store = {
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
  if (raw.version === 1) {
    // Keep the original inode so a downgrade has an exact, private snapshot.
    try {
      fs.linkSync(file, path.join(dir, 'config.v1.json'));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    store.save(cfg);
  }
  return store;
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

/**
 * Parse pasted Claude/Antigravity/Cursor JSON (`mcpServers`) or Codex TOML (`[mcp_servers.*]`)
 * into validated MCP Shelf connection candidates. Secret env values are never stored.
 */
export function parseImportConfig(rawText) {
  const input = limited(rawText, '导入内容', 200_000, true);
  let entries;
  let format;

  if (input.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw fail('JSON 格式无效，请检查括号与引号。');
    }
    if (Object.hasOwn(parsed, 'mcpServers')) {
      if (!rec(parsed.mcpServers)) throw fail('mcpServers 必须是对象。');
      entries = parsed.mcpServers;
    } else if (['command', 'url', 'serverUrl'].some((key) => Object.hasOwn(parsed, key))) {
      entries = { [parsed.id || 'imported']: parsed };
    } else {
      entries = parsed;
    }
    format = 'json';
  } else {
    try {
      entries = parseToml(input, { integersAsBigInt: 'asNeeded', unsafeKeyBehaviour: 'throw' }).mcp_servers;
    } catch (err) {
      const at = Number.isInteger(err.line) ? `（第 ${err.line} 行）` : '';
      throw fail(`TOML 格式无效${at}，请检查配置文件。`);
    }
    if (!rec(entries) || entries instanceof Date) {
      throw fail('未找到 Codex config.toml 的 mcp_servers 配置表。');
    }
    format = 'toml';
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

    try {
      const hasCommand = Object.hasOwn(cfg, 'command');
      const hasUrl = Object.hasOwn(cfg, 'url');
      const hasServerUrl = Object.hasOwn(cfg, 'serverUrl');
      if (hasCommand && (hasUrl || hasServerUrl)) throw fail('command 与 MCP URL 不能同时设置。');
      if (hasUrl && hasServerUrl && cfg.url !== cfg.serverUrl) {
        throw fail('url 与 serverUrl 指向不同的值。');
      }
      if (hasCommand) {
        candidate.transport = 'stdio';
        candidate.command = cfg.command;
        candidate.args = cfg.args;
        candidate.cwd = cfg.cwd;
        const envKeys = array(cfg.envKeys, isAllowedEnvName, '环境变量名', 50);
        const keys = rec(cfg.env) ? Object.keys(cfg.env).filter((k) => envName.test(k)) : [];
        if (cfg.env !== undefined && !rec(cfg.env)) throw fail('env 必须是对象。');
        if (keys.length) {
          warnings.push(`仅导入环境变量名 (${keys.join(', ')})，未保存明文值，请在启动网关的环境中设置。`);
        }
        candidate.envKeys = [...new Set([...envKeys, ...keys])];
      } else if (hasUrl || hasServerUrl) {
        candidate.transport = 'http';
        candidate.url = hasUrl ? cfg.url : cfg.serverUrl;
        candidate.bearerEnv = cfg.bearerEnv === undefined ? cfg.bearer_token_env_var : cfg.bearerEnv;
        if (rec(cfg.headers) && Object.keys(cfg.headers).length && !candidate.bearerEnv) {
          warnings.push('检测到自定义 headers，未导入明文凭据；如需认证请配置 Bearer 环境变量名。');
        }
      } else {
        throw fail('缺少 command、url 或 serverUrl。');
      }
      const validated = source(candidate);
      seen.add(id);
      items.push({ server: validated, warnings });
    } catch (err) {
      skipped.push({ id: rawKey, reason: err.message });
    }
  }

  return { format, items, skipped };
}
