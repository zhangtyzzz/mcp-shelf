import {
  LOCALES,
  applyStaticTranslations,
  detectLocale,
  getLocale,
  setLocale,
  t
} from './i18n.js';

const $ = (s) => document.querySelector(s);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') {
      for (const [event, fn] of Object.entries(v)) e.addEventListener(event, fn);
    } else if (['value', 'checked', 'disabled', 'open'].includes(k)) {
      e[k] = v;
    } else if (v !== undefined && v !== null) {
      e.setAttribute(k, v);
    }
  }
  e.append(...children.flat(Infinity).filter((x) => x != null));
  return e;
}

const btn = (label, onclick, css = '') =>
  el('button', { type: 'button', class: css, on: { click: onclick } }, label);
const pill = (label, cls = '') => el('span', { class: 'pill ' + cls }, label);
const actions = (...children) => el('div', { class: 'actions' }, children);
const panel = (title, extra, ...children) =>
  el(
    'section',
    { class: 'panel' },
    el('header', { class: 'panel-head' }, el('h2', {}, title), extra),
    children
  );
const empty = (label, desc, cta) =>
  el('div', { class: 'blank' }, el('b', {}, label), el('div', {}, desc), cta);
const hero = (code, title, sub, cta) =>
  el(
    'header',
    { class: 'hero' },
    el('div', {}, el('div', { class: 'kicker' }, code), el('h1', {}, title), el('p', {}, sub)),
    cta
  );
const hint = (text) => el('p', { class: 'hint' }, text);

const routeKeys = {
  sources: 'nav.sources',
  tools: 'nav.tools',
  logs: 'nav.logs',
  meta: 'nav.meta',
  clients: 'nav.clients'
};

const statusKeys = {
  ready: 'status.ready',
  disabled: 'status.disabled',
  idle: 'status.idle',
  error: 'status.error'
};

const logStatuses = {
  ok: ['log.ok', 'ok'],
  blocked: ['log.blocked', 'warn'],
  invalid: ['log.invalid', 'warn'],
  upstream_error: ['log.upstream_error', 'bad'],
  error: ['log.error', 'bad']
};

let state;
let logs = [];
let view = Object.hasOwn(routeKeys, location.hash.slice(1)) ? location.hash.slice(1) : 'sources';
let q = '';
let filter = '';
let allowOnly = false;
let logSourceFilter = '';
let logAutoRefresh = false;
let logPollTimer = null;
let toastTimer;
let editing;
let originButton;
let busy = false;
let needsLogin = false;

const expandedTools = new Set();
const tryArgsCache = new Map();
const tryResults = new Map();

async function request(route, method = 'GET', data) {
  const r = await fetch('/api/' + route, {
    method,
    headers: {
      ...(method !== 'GET' && state?.csrf ? { 'X-Shelf-CSRF': state.csrf } : {}),
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const j = await r.json();
  if (!r.ok) {
    const err = Error(j.error || t('toast.requestFailed'));
    err.status = r.status;
    err.authRequired = !!j.auth_required;
    throw err;
  }
  return j;
}

function updateInstanceChrome() {
  const mode = needsLogin ? 'remote' : state?.mode;
  if (!mode) return;
  const remote = mode === 'remote';
  const tag = $('#instance-tag');
  if (tag) {
    const prefix = remote ? t('top.remote') : t(state.demo ? 'top.localDemo' : 'top.local');
    tag.textContent = needsLogin || (remote && state.publicUrl) ? prefix : `${prefix} · :${state.port}`;
    tag.parentElement.hidden = false;
  }
  const modeLabel = $('#mode-label');
  if (modeLabel) {
    modeLabel.textContent = t(remote ? 'footer.remote' : 'footer.local');
  }
}

async function load() {
  state = await request('state');
  needsLogin = false;
  updateInstanceChrome();
}

async function loadLogs() {
  const res = await request('logs');
  logs = res.logs || [];
}

function toast(message, bad = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = bad ? 'err' : '';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4000);
}

async function run(e, fn, message) {
  if (busy) return;
  busy = true;
  const target = e?.currentTarget;
  if (target) target.disabled = true;
  try {
    const out = await fn();
    await load();
    if (view === 'logs') await loadLogs();
    render();
    const msg = typeof message === 'function' ? message(out) : message;
    if (msg) toast(msg);
  } catch (err) {
    try {
      await load();
      render();
    } catch {}
    toast(err.message, true);
  } finally {
    busy = false;
    if (target) target.disabled = false;
  }
}

const update = ({ tools, status, error, missingEnvKeys, oauthStatus, ...s }, more) =>
  request('servers/' + s.id, 'PUT', { ...s, ...more });

function skeletonFromSchema(schema) {
  if (!schema || typeof schema !== 'object' || !schema.properties) return '{}';
  const obj = {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!required.has(key) && Object.keys(schema.properties).length > 5) continue;
    const tp = Array.isArray(prop?.type) ? prop.type[0] : prop?.type;
    if (prop?.default !== undefined) obj[key] = prop.default;
    else if (Array.isArray(prop?.enum) && prop.enum.length) obj[key] = prop.enum[0];
    else if (tp === 'string') obj[key] = '';
    else if (tp === 'number' || tp === 'integer') obj[key] = 0;
    else if (tp === 'boolean') obj[key] = false;
    else if (tp === 'array') obj[key] = [];
    else if (tp === 'object') obj[key] = {};
    else obj[key] = '';
  }
  return JSON.stringify(obj, null, 2);
}

function annotationBadges(annotations) {
  if (!annotations || typeof annotations !== 'object') return [];
  const badges = [];
  if (annotations.readOnlyHint === true) {
    badges.push(el('span', { class: 'badge', title: t('tools.badge.readOnlyTip') }, t('tools.badge.readOnly')));
  }
  if (annotations.destructiveHint === true) {
    badges.push(
      el('span', { class: 'badge warn', title: t('tools.badge.destructiveTip') }, t('tools.badge.destructive'))
    );
  }
  if (annotations.idempotentHint === true) {
    badges.push(
      el('span', { class: 'badge', title: t('tools.badge.idempotentTip') }, t('tools.badge.idempotent'))
    );
  }
  return badges;
}

function sources() {
  const all = state.servers;
  const hasEnabled = all.some((s) => s.enabled);
  const metrics = el(
    'div',
    { class: 'metrics' },
    [
      [t('sources.metric.servers'), all.length],
      [
        t('sources.metric.tools'),
        all
          .filter((s) => s.enabled)
          .reduce((n, s) => n + s.tools.filter((tl) => s.allowlist.includes(tl.name)).length, 0)
      ],
      [t('sources.metric.meta'), state.meta.length]
    ].map(([l, n]) => el('div', { class: 'metric' }, l, el('b', {}, String(n).padStart(2, '0'))))
  );

  const rows = all.map((s) => {
    const allowedCount = s.tools.filter((tl) => s.allowlist.includes(tl.name)).length;
    return el(
      'article',
      { class: 'row' },
      el(
        'div',
        { class: 'row-main' },
        el('span', { class: 'symbol' }, s.transport === 'stdio' ? '⌘' : '↗'),
        el(
          'div',
          {},
          el('h3', {}, s.label),
          el(
            'div',
            { class: 'sub mono' },
            t('sources.metaLine', {
              id: s.id,
              transport: s.transport === 'stdio' ? 'stdio' : 'Streamable HTTP',
              discovered: s.tools.length,
              allowed: allowedCount
            })
          ),
          s.description ? el('p', {}, s.description) : null,
          s.missingEnvKeys?.length
            ? el('div', { class: 'warn-note' }, t('sources.missingEnv', { keys: s.missingEnvKeys.join(', ') }))
            : null,
          s.error ? el('div', { class: 'err' }, s.error) : null
        )
      ),
      actions(
        pill(t(statusKeys[s.status] || 'status.idle'), s.status === 'ready' ? 'ok' : s.status === 'error' ? 'bad' : ''),
        s.oauthStatus
          ? pill(
              s.oauthStatus === 'connected' ? t('sources.oauthConnected') : t('sources.oauthRequired'),
              s.oauthStatus === 'connected' ? 'ok' : 'warn'
            )
          : null,
        s.enabled && s.authMode === 'oauth' && s.oauthStatus !== 'connected'
          ? btn(
              t('sources.oauthSignIn'),
              async (e) => {
                const target = e.currentTarget;
                target.disabled = true;
                try {
                  const res = await request('servers/' + s.id + '/oauth/start', 'POST');
                  if (res.status === 'authorized') {
                    await load();
                    render();
                    toast(t('toast.oauthAuthorized'));
                  } else if (res.authorizeUrl) {
                    const u = new URL(res.authorizeUrl);
                    const safe =
                      u.protocol === 'https:' ||
                      (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
                    if (!safe) throw new Error('Blocked unsafe OAuth redirect URL.');
                    window.open(u.href, '_blank', 'noopener,noreferrer');
                    toast(t('toast.oauthStarted'));
                  }
                } catch (err) {
                  toast(err.message, true);
                } finally {
                  target.disabled = false;
                }
              },
              'mini primary'
            )
          : null,
        s.authMode === 'oauth' && s.oauthStatus === 'connected'
          ? btn(
              t('sources.oauthSignOut'),
              (e) => run(e, () => request('servers/' + s.id + '/oauth/logout', 'POST'), t('toast.oauthCleared')),
              'mini'
            )
          : null,
        s.enabled
          ? btn(
              t('sources.refresh'),
              (e) => run(e, () => request('servers/' + s.id + '/refresh', 'POST'), t('toast.refreshed')),
              'mini'
            )
          : null,
        btn(t('sources.edit'), (e) => openEditor(s, e.currentTarget), 'mini'),
        btn(
          s.enabled ? t('sources.disable') : t('sources.enable'),
          (e) =>
            run(
              e,
              () => update(s, { enabled: !s.enabled }),
              s.enabled ? t('toast.disabled') : t('toast.enabled')
            ),
          'mini'
        )
      )
    );
  });

  const panelExtra = actions(
    el('span', { class: 'sub' }, t('sources.count', { count: all.length })),
    btn(
      t('backup.download'),
      async () => {
        try {
          const data = await request('backup');
          const blob = new Blob([JSON.stringify(data) + '\n'], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = el('a', { href: url, download: 'mcp-shelf-backup.json' });
          link.click();
          URL.revokeObjectURL(url);
          toast(t('backup.downloaded'));
        } catch (err) {
          toast(err.message, true);
        }
      },
      'mini'
    ),
    btn(t('backup.restore'), (e) => openRestore(e.currentTarget), 'mini'),
    hasEnabled
      ? btn(
          t('sources.refreshAll'),
          (e) =>
            run(
              e,
              () => request('servers/refresh-all', 'POST'),
              (res) => {
                const okCount = (res.results || []).filter((r) => r.status === 'ready').length;
                return t('toast.refreshedAll', { total: res.results?.length || 0, ready: okCount });
              }
            ),
          'mini'
        )
      : null
  );

  return [
    hero(
      t('sources.kicker'),
      t('sources.title'),
      t('sources.sub'),
      actions(
        btn(t('sources.templates'), (e) => openTemplates(e.currentTarget)),
        btn(t('sources.add'), (e) => openEditor(null, e.currentTarget), 'primary')
      )
    ),
    metrics,
    panel(
      t('sources.panel'),
      panelExtra,
      rows.length
        ? rows
        : empty(
            t('sources.emptyTitle'),
            t('sources.emptyDesc'),
            btn(t('sources.templates'), (e) => openTemplates(e.currentTarget), 'primary')
          )
    ),
    hint(t('sources.hint'))
  ];
}

function batchToggle(rows, allow) {
  const byServer = new Map();
  for (const { s, tl } of rows) {
    if (!s.enabled) continue;
    const set = byServer.get(s.id) || { s, names: new Set(s.allowlist) };
    if (allow) set.names.add(tl.name);
    else set.names.delete(tl.name);
    byServer.set(s.id, set);
  }
  const tasks = [];
  for (const { s, names } of byServer.values()) {
    const next = [...names];
    if (next.length !== s.allowlist.length || next.some((x) => !s.allowlist.includes(x))) {
      tasks.push(() => update(s, { allowlist: next }));
    }
  }
  return tasks;
}

function toolRows(body) {
  const needle = q.trim().normalize('NFKC').toLowerCase();
  const rows = state.servers
    .filter((s) => !filter || s.id === filter)
    .flatMap((s) => s.tools.map((tl) => ({ s, tl })))
    .filter(
      ({ s, tl }) =>
        (!allowOnly || (s.enabled && s.allowlist.includes(tl.name))) &&
        (!needle ||
          (tl.tool_id + ' ' + tl.description + ' ' + s.label)
            .normalize('NFKC')
            .toLowerCase()
            .includes(needle))
    );

  const countLabel =
    rows.length > 300
      ? t('tools.countCapped', { count: rows.length })
      : t('tools.count', { count: rows.length });
  const enabledRows = rows.filter(({ s }) => s.enabled);
  const canAllowAny = enabledRows.some(({ s, tl }) => !s.allowlist.includes(tl.name));
  const canRevokeAny = enabledRows.some(({ s, tl }) => s.allowlist.includes(tl.name));

  const headExtra = actions(
    el('span', { class: 'sub' }, countLabel),
    canAllowAny
      ? btn(
          t('tools.allowAll'),
          (e) => {
            if (!confirm(t('tools.confirmAllowAll', { count: enabledRows.length }))) return;
            const tasks = batchToggle(enabledRows, true);
            run(
              e,
              async () => {
                for (const fn of tasks) await fn();
              },
              t('toast.batchAllowed')
            );
          },
          'mini'
        )
      : null,
    canRevokeAny
      ? btn(
          t('tools.revokeAll'),
          (e) => {
            if (!confirm(t('tools.confirmRevokeAll'))) return;
            const tasks = batchToggle(enabledRows, false);
            run(
              e,
              async () => {
                for (const fn of tasks) await fn();
              },
              t('toast.batchRevoked')
            );
          },
          'mini'
        )
      : null
  );

  body.replaceChildren(
    panel(
      t('tools.panel'),
      headExtra,
      rows.length
        ? rows.slice(0, 300).map(({ s, tl }) => {
            const has = s.allowlist.includes(tl.name);
            const isOpen = expandedTools.has(tl.tool_id);
            const area = el('textarea', {
              'aria-label': t('tools.customDescAria', { toolId: tl.tool_id }),
              value: s.overrides[tl.name] || '',
              maxlength: 2400,
              rows: 3,
              placeholder: t('tools.customDescPlaceholder')
            });

            const defaultArgs = tryArgsCache.has(tl.tool_id)
              ? tryArgsCache.get(tl.tool_id)
              : skeletonFromSchema(tl.inputSchema);
            let tryBtn;
            const tryInput = el('textarea', {
              'aria-label': t('tools.tryAria', { toolId: tl.tool_id }),
              class: 'mono',
              rows: 3,
              value: defaultArgs,
              on: {
                input: (e) => {
                  tryArgsCache.set(tl.tool_id, e.target.value);
                },
                keydown: (e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    tryBtn?.click();
                  }
                }
              }
            });

            const resultBox = el('div');
            const renderTryResult = () => {
              const res = tryResults.get(tl.tool_id);
              if (!res) {
                resultBox.replaceChildren();
                return;
              }
              const isErr = res.isError || res.result?.isError;
              resultBox.replaceChildren(
                el(
                  'div',
                  { class: 'try-result' + (isErr ? ' err' : '') },
                  el(
                    'div',
                    {},
                    el('strong', {}, isErr ? t('tools.tryErr') : t('tools.tryOk')),
                    res.durationMs != null ? ` · ${res.durationMs} ms` : ''
                  ),
                  el('pre', {}, typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2))
                )
              );
            };
            renderTryResult();

            const resetArgsBtn = btn(
              t('tools.tryReset'),
              () => {
                const sk = skeletonFromSchema(tl.inputSchema);
                tryInput.value = sk;
                tryArgsCache.set(tl.tool_id, sk);
              },
              'mini'
            );

            tryBtn = btn(
              t('tools.tryRun'),
              async (e) => {
                let parsedArgs;
                try {
                  parsedArgs = JSON.parse(tryInput.value.trim() || '{}');
                  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
                    throw Error(t('tools.tryMustObj'));
                  }
                } catch (err) {
                  tryResults.set(tl.tool_id, {
                    isError: true,
                    body: t('tools.tryInvalidJson', { error: err.message })
                  });
                  renderTryResult();
                  return;
                }
                const target = e.currentTarget;
                target.disabled = true;
                try {
                  const res = await request('tools/test', 'POST', {
                    tool_id: tl.tool_id,
                    arguments: parsedArgs
                  });
                  tryResults.set(tl.tool_id, {
                    isError: !!res.result?.isError,
                    durationMs: res.durationMs,
                    result: res.result,
                    body: res.result?.structuredContent ?? res.result?.content ?? res.result
                  });
                  renderTryResult();
                } catch (err) {
                  tryResults.set(tl.tool_id, { isError: true, body: err.message });
                  renderTryResult();
                } finally {
                  target.disabled = false;
                }
              },
              'mini'
            );

            const detailsEl = el(
              'details',
              {
                open: isOpen,
                on: {
                  toggle: (e) => {
                    if (e.currentTarget.open) expandedTools.add(tl.tool_id);
                    else expandedTools.delete(tl.tool_id);
                  }
                }
              },
              el('summary', {}, t('tools.details')),
              el(
                'p',
                { class: 'sub' },
                tl.schemaHash
                  ? t('tools.inputSchemaHash', { hash: tl.schemaHash })
                  : t('tools.inputSchema')
              ),
              el('pre', { class: 'snippet' }, JSON.stringify(tl.inputSchema, null, 2)),
              tl.outputSchema
                ? el(
                    'div',
                    {},
                    el('p', { class: 'sub' }, t('tools.outputSchema')),
                    el('pre', { class: 'snippet' }, JSON.stringify(tl.outputSchema, null, 2))
                  )
                : null,
              el('label', {}, t('tools.customDesc'), area),
              btn(
                t('tools.saveDesc'),
                (e) =>
                  run(
                    e,
                    () => update(s, { overrides: { ...s.overrides, [tl.name]: area.value } }),
                    t('toast.descSaved')
                  ),
                'mini'
              ),
              s.enabled
                ? el(
                    'div',
                    { class: 'try-box' },
                    el(
                      'div',
                      { class: 'try-head' },
                      el('span', { class: 'sub' }, t('tools.tryTitle')),
                      actions(resetArgsBtn, tryBtn)
                    ),
                    tryInput,
                    resultBox
                  )
                : null
            );

            return el(
              'article',
              { class: 'tool' },
              el(
                'div',
                { class: 'tool-top' },
                el(
                  'div',
                  {},
                  el(
                    'div',
                    { class: 'tool-title' },
                    tl.icons?.[0]?.src
                      ? el('img', { class: 'tool-icon', src: tl.icons[0].src, alt: '' })
                      : null,
                    el('h2', { class: 'mono' }, tl.tool_id),
                    tl.title ? el('span', { class: 'sub' }, tl.title) : null,
                    tl.schemaDrifted ? pill(t('tools.schemaDrifted'), 'warn') : null,
                    ...annotationBadges(tl.annotations)
                  ),
                  el('p', {}, tl.description || t('tools.noDesc'))
                ),
                actions(
                  pill(
                    has && s.enabled && !tl.schemaDrifted ? t('tools.allowed') : t('tools.blocked'),
                    has && s.enabled && !tl.schemaDrifted ? 'ok' : tl.schemaDrifted ? 'warn' : ''
                  ),
                  tl.schemaDrifted
                    ? btn(
                        t('tools.reapprove'),
                        (e) => run(e, () => update(s, { reapproveTool: tl.name }), t('toast.reapproved')),
                        'mini primary'
                      )
                    : null,
                  btn(
                    has ? t('tools.revoke') : t('tools.allow'),
                    (e) =>
                      run(
                        e,
                        () =>
                          update(s, {
                            allowlist: has
                              ? s.allowlist.filter((n) => n !== tl.name)
                              : [...s.allowlist, tl.name]
                          }),
                        has ? t('toast.revoked') : t('toast.allowed')
                      ),
                    'mini'
                  )
                )
              ),
              detailsEl
            );
          })
        : empty(t('tools.emptyTitle'), t('tools.emptyDesc'))
    )
  );
}

function tools() {
  const body = el('div');
  toolRows(body);
  const input = el('input', {
    type: 'search',
    'aria-label': t('tools.searchAria'),
    placeholder: t('tools.searchPlaceholder'),
    value: q,
    on: {
      input: (e) => {
        q = e.target.value;
        toolRows(body);
      }
    }
  });
  const select = el(
    'select',
    {
      'aria-label': t('tools.filterServerAria'),
      on: {
        change: (e) => {
          filter = e.target.value;
          toolRows(body);
        }
      }
    },
    el('option', { value: '' }, t('tools.allServers')),
    state.servers.map((s) => el('option', { value: s.id }, s.label))
  );
  select.value = filter;
  const allowed = el(
    'label',
    { class: 'check' },
    el('input', {
      type: 'checkbox',
      checked: allowOnly,
      on: {
        change: (e) => {
          allowOnly = e.target.checked;
          toolRows(body);
        }
      }
    }),
    t('tools.allowOnly')
  );
  return [
    hero(t('tools.kicker'), t('tools.title'), t('tools.sub')),
    el('div', { class: 'filters' }, input, select, allowed),
    body
  ];
}

function syncLogPolling() {
  clearInterval(logPollTimer);
  logPollTimer = null;
  if (view === 'logs' && logAutoRefresh) {
    logPollTimer = setInterval(async () => {
      if (document.hidden || view !== 'logs') return;
      try {
        await loadLogs();
        render();
      } catch {}
    }, 3000);
  }
}

function logsView() {
  const formatTime = (iso) => {
    try {
      return new Date(iso).toLocaleTimeString(getLocale(), { hour12: false });
    } catch {
      return iso;
    }
  };

  const filtered = logs.filter((item) => !logSourceFilter || item.source === logSourceFilter);

  const rows = filtered.map((item) => {
    const [labelKey, cls] = logStatuses[item.status] || [item.status, ''];
    const hasPayload = Boolean(item.argsPreview || item.resultPreview);
    return el(
      'article',
      { class: 'log-row' },
      el(
        'div',
        { class: 'log-row-head' },
        el(
          'div',
          { class: 'log-main' },
          el(
            'div',
            { class: 'log-title' },
            pill(item.source === 'playground' ? t('log.source.playground') : t('log.source.agent')),
            el('strong', { class: 'mono' }, item.action),
            el('code', { class: 'sub' }, item.target)
          ),
          item.detail ? el('div', { class: 'sub' }, item.detail) : null
        ),
        el(
          'div',
          { class: 'log-meta' },
          pill(t(labelKey), cls),
          el('span', { class: 'mono' }, `${item.durationMs} ms`),
          el('span', { class: 'mono' }, formatTime(item.at))
        )
      ),
      hasPayload
        ? el(
            'details',
            { class: 'log-details' },
            el('summary', {}, t('logs.detailsToggle')),
            item.argsPreview
              ? el('div', {}, el('div', { class: 'sub' }, t('logs.argsLabel')), el('pre', { class: 'snippet' }, item.argsPreview))
              : null,
            item.resultPreview
              ? el(
                  'div',
                  {},
                  el('div', { class: 'sub' }, t('logs.resultLabel')),
                  el('pre', { class: 'snippet' }, item.resultPreview)
                )
              : null,
            item.action === 'call_tool' && item.argsPreview
              ? btn(
                  t('logs.replay'),
                  () => {
                    tryArgsCache.set(item.target, item.argsPreview);
                    expandedTools.add(item.target);
                    q = item.target;
                    void switchView('tools');
                  },
                  'mini'
                )
              : null
          )
        : null
    );
  });

  const sourceSelect = el(
    'select',
    {
      'aria-label': t('logs.filterAria'),
      class: 'auto-select',
      on: {
        change: (e) => {
          logSourceFilter = e.target.value;
          render();
        }
      }
    },
    el('option', { value: '' }, t('logs.allSources')),
    el('option', { value: 'agent' }, t('logs.onlyAgent')),
    el('option', { value: 'playground' }, t('logs.onlyPlayground'))
  );
  sourceSelect.value = logSourceFilter;

  const currentSettings = state.settings || { logLimit: 200, logDetails: false, idleMinutes: 10 };
  const saveSetting = (e, patch) =>
    run(e, () => request('settings', 'PUT', patch), t('toast.settingsSaved'));

  const limitSelect = el(
    'select',
    {
      class: 'auto-select',
      'aria-label': t('logs.maxEntries'),
      on: { change: (e) => saveSetting(e, { logLimit: Number(e.target.value) }) }
    },
    el('option', { value: '0' }, t('logs.disabled')),
    el('option', { value: '50' }, '50'),
    el('option', { value: '200' }, '200'),
    el('option', { value: '500' }, '500'),
    el('option', { value: '1000' }, '1000')
  );
  limitSelect.value = String(currentSettings.logLimit);

  const idleSelect = el(
    'select',
    {
      class: 'auto-select',
      'aria-label': t('logs.idleLabel'),
      on: { change: (e) => saveSetting(e, { idleMinutes: Number(e.target.value) }) }
    },
    el('option', { value: '0' }, t('logs.idleOff')),
    el('option', { value: '5' }, t('logs.idleMin', { m: 5 })),
    el('option', { value: '10' }, t('logs.idleMin', { m: 10 })),
    el('option', { value: '30' }, t('logs.idleMin', { m: 30 })),
    el('option', { value: '60' }, t('logs.idleMin', { m: 60 }))
  );
  idleSelect.value = String(currentSettings.idleMinutes);

  const detailsCheck = el(
    'label',
    { class: 'check' },
    el('input', {
      type: 'checkbox',
      checked: currentSettings.logDetails,
      on: { change: (e) => saveSetting(e, { logDetails: e.target.checked }) }
    }),
    t('logs.recordDetails')
  );

  const driftCheck = el(
    'label',
    { class: 'check' },
    el('input', {
      type: 'checkbox',
      checked: currentSettings.strictSchemaDrift !== false,
      on: { change: (e) => saveSetting(e, { strictSchemaDrift: e.target.checked }) }
    }),
    t('logs.strictDrift')
  );

  const settingsBar = el(
    'div',
    { class: 'settings-bar' },
    el('label', { class: 'settings-field' }, t('logs.maxEntries'), limitSelect),
    detailsCheck,
    el('label', { class: 'settings-field' }, t('logs.idleLabel'), idleSelect),
    driftCheck
  );

  const autoCheck = el(
    'label',
    { class: 'check' },
    el('input', {
      type: 'checkbox',
      checked: logAutoRefresh,
      on: {
        change: (e) => {
          logAutoRefresh = e.target.checked;
          syncLogPolling();
        }
      }
    }),
    t('logs.autoRefresh')
  );

  return [
    hero(
      t('logs.kicker'),
      t('logs.title'),
      t('logs.sub'),
      actions(
        autoCheck,
        btn(t('logs.refresh'), (e) => run(e, () => loadLogs(), t('toast.logsRefreshed'))),
        logs.length
          ? btn(t('logs.clear'), (e) => run(e, () => request('logs', 'DELETE'), t('toast.logsCleared')), 'danger')
          : null
      )
    ),
    settingsBar,
    panel(
      t('logs.panel'),
      actions(
        sourceSelect,
        el('span', { class: 'sub' }, t('logs.count', { shown: filtered.length, total: logs.length }))
      ),
      rows.length ? rows : empty(t('logs.emptyTitle'), t('logs.emptyDesc'))
    )
  ];
}

function meta() {
  const areas = {};
  const cards = state.meta.map((m) => {
    const input = el('textarea', {
      'aria-label': m.name,
      rows: 3,
      maxlength: 2400,
      value: state.descriptions[m.name]
    });
    areas[m.name] = input;
    return panel(
      m.title,
      el('code', { class: 'sub' }, m.name),
      el(
        'div',
        { class: 'inside' },
        el('p', {}, m.name === 'call_tool' ? t('meta.callToolNote') : t('meta.otherNote')),
        input
      )
    );
  });
  const save = btn(
    t('meta.save'),
    (e) =>
      run(
        e,
        () =>
          request(
            'descriptions',
            'PUT',
            Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.value]))
          ),
        t('toast.metaSaved')
      ),
    'primary'
  );
  const fill = btn(t('meta.reset'), () => {
    for (const [k, v] of Object.entries(areas)) v.value = state.defaults[k];
    toast(t('toast.metaFilled'));
  });
  const reminderPanel = panel(
    t('meta.reminderTitle'),
    pill(t('meta.fingerprint', { fp: state.fingerprint || '—' }), 'ok'),
    el(
      'div',
      { class: 'inside' },
      el('p', {}, t('meta.reminderDesc')),
      el('pre', { class: 'snippet' }, state.serverReminder || t('meta.reminderEmpty'))
    )
  );
  return [
    hero(t('meta.kicker'), t('meta.title'), t('meta.sub'), save),
    el('div', { class: 'stack' }, reminderPanel, ...cards),
    hint(t('meta.hint')),
    fill
  ];
}

function copyEndpoint(url) {
  return btn(
    t('clients.copyEndpoint'),
    async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast(t('toast.copied'));
      } catch {
        toast(t('toast.copyFailed'), true);
      }
    },
    'mini primary'
  );
}

function clients() {
  const remoteUrl = state.remoteEndpoint;
  const tokenBox = el('div');
  const setupPanel = panel(
    t('clients.setupTitle'),
    actions(
      copyEndpoint(remoteUrl),
      state.mode === 'remote'
        ? btn(
            t('clients.logout'),
            async () => {
              await request('auth/logout', 'POST');
              location.reload();
            },
            'mini'
          )
        : null
    ),
    el(
      'div',
      { class: 'inside' },
      el('pre', { class: 'snippet' }, remoteUrl),
      el('p', {}, t('clients.authHint')),
      el(
        'div',
        { class: 'token-controls' },
        actions(
          btn(
            t('clients.showToken'),
            async (e) => {
              const target = e.currentTarget;
              target.disabled = true;
              try {
                const res = await request('token', 'POST');
                tokenBox.replaceChildren(el('pre', { class: 'snippet' }, res.token));
                try {
                  await navigator.clipboard.writeText(res.token);
                  toast(t('toast.tokenCopied'));
                } catch {
                  toast(t('toast.tokenShown'));
                }
              } catch (err) {
                toast(err.message, true);
              } finally {
                target.disabled = false;
              }
            },
            'mini'
          ),
          btn(
            t('clients.rotateToken'),
            async (e) => {
              if (!confirm(t('clients.confirmRotate'))) return;
              const target = e.currentTarget;
              target.disabled = true;
              try {
                const res = await request('token/rotate', 'POST');
                tokenBox.replaceChildren(el('pre', { class: 'snippet' }, res.token));
                toast(t('toast.tokenRotated'));
              } catch (err) {
                toast(err.message, true);
              } finally {
                target.disabled = false;
              }
            },
            'mini danger'
          )
        ),
        tokenBox
      )
    )
  );

  const profilesList = state.profiles || [];
  const profileRows = profilesList.map((pr) => {
    const scopeLabel = pr.scope === 'all'
      ? t('profiles.allServers')
      : pr.servers.join(', ') || t('profiles.noServers');
    const endpoint = remoteUrl + '/' + pr.id;
    const tokOut = el('div');
    return el(
      'article',
      { class: 'row' },
      el(
        'div',
        { class: 'row-main' },
        el('span', { class: 'symbol' }, '◎'),
        el(
          'div',
          {},
          el('h3', {}, pr.label),
          el('div', { class: 'sub mono' }, `${pr.id} · ${scopeLabel}`),
          pr.description ? el('p', {}, pr.description) : null,
          tokOut
        )
      ),
      actions(
        copyEndpoint(endpoint),
        btn(
          t('profiles.copyToken'),
          async (e) => {
            const target = e.currentTarget;
            target.disabled = true;
            try {
              const res = await request(`profiles/${pr.id}/token`, 'POST');
              tokOut.replaceChildren(el('pre', { class: 'snippet' }, `${endpoint}\nAuthorization: Bearer ${res.token}`));
              try {
                await navigator.clipboard.writeText(res.token);
              } catch {}
              toast(t('toast.profileTokenCopied'));
            } catch (err) {
              toast(err.message, true);
            } finally {
              target.disabled = false;
            }
          },
          'mini'
        ),
        btn(
          t('profiles.rotate'),
          async (e) => {
            if (!confirm(t('clients.confirmRotate'))) return;
            const target = e.currentTarget;
            target.disabled = true;
            try {
              const res = await request(`profiles/${pr.id}/rotate`, 'POST');
              tokOut.replaceChildren(el('pre', { class: 'snippet' }, res.token));
              toast(t('toast.profileRotated'));
            } catch (err) {
              toast(err.message, true);
            } finally {
              target.disabled = false;
            }
          },
          'mini'
        ),
        btn(t('profiles.edit'), (e) => openProfileEditor(pr, e.currentTarget), 'mini'),
        btn(
          t('profiles.delete'),
          (e) => {
            if (!confirm(t('profiles.confirmDelete', { id: pr.id }))) return;
            run(e, () => request('profiles/' + pr.id, 'DELETE'), t('toast.profileDeleted'));
          },
          'mini danger'
        )
      )
    );
  });

  const profilesPanel = panel(
    t('profiles.title'),
    btn(t('profiles.add'), (e) => openProfileEditor(null, e.currentTarget), 'mini primary'),
    el('div', { class: 'inside' }, el('p', {}, t('profiles.sub'))),
    profileRows.length ? profileRows : el('div', { class: 'inside' }, el('p', { class: 'sub' }, t('profiles.empty')))
  );

  return [
    hero(t('clients.kicker'), t('clients.title'), t('clients.sub')),
    el('div', { class: 'stack' }, setupPanel, profilesPanel)
  ];
}

function render() {
  if (needsLogin) {
    renderLogin();
    return;
  }
  $('#crumb').textContent = t(routeKeys[view]);
  for (const b of document.querySelectorAll('nav button')) {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const views = { sources, tools, logs: logsView, meta, clients };
  $('#content').replaceChildren(...views[view]());
  $('#content').removeAttribute('aria-busy');
}

// Connection editor dialog
const dialog = $('#dialog');
const form = $('#form');
const f = (name) => form.elements.namedItem(name);

function transport() {
  const std = f('transport').value === 'stdio';
  $('#stdio').hidden = !std;
  $('#http').hidden = std;
  f('command').required = std;
  f('url').required = !std;
  const authMode = f('authMode').value;
  $('#bearer-wrap').hidden = std || authMode !== 'bearer';
}

function openEditor(s, button, isPrefill = false) {
  editing = isPrefill ? null : s;
  originButton = button;
  form.reset();
  f('id').readOnly = !!editing;
  for (const k of ['id', 'label', 'description', 'transport', 'command', 'cwd', 'url', 'authMode', 'bearerEnv']) {
    if (s?.[k]) f(k).value = s[k];
  }
  if (!s?.authMode) f('authMode').value = s?.bearerEnv ? 'bearer' : 'none';
  f('enabled').checked = s ? s.enabled : true;
  f('args').value = s?.args ? JSON.stringify(s.args) : '';
  f('envKeys').value = s?.envKeys?.join(', ') || '';
  $('#form-title').textContent = editing ? t('dialog.editTitle') : t('dialog.addTitle');
  $('#error').textContent = '';
  $('#delete-source')?.remove();
  if (editing) {
    const remove = btn(
      t('dialog.delete'),
      (e) => {
        if (confirm(t('dialog.confirmDelete'))) {
          dialog.close();
          void run(e, () => request('servers/' + editing.id, 'DELETE'), t('toast.deleted'));
        }
      },
      'danger'
    );
    remove.id = 'delete-source';
    $('#cancel').before(remove);
  }
  transport();
  dialog.showModal();
}

$('#x').onclick = $('#cancel').onclick = () => dialog.close();
dialog.addEventListener('close', () => originButton?.focus());
f('transport').addEventListener('change', transport);
f('authMode').addEventListener('change', transport);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#error');
  error.textContent = '';
  let args = [];
  if (f('transport').value === 'stdio') {
    try {
      args = JSON.parse(f('args').value || '[]');
      if (!Array.isArray(args) || args.some((x) => typeof x !== 'string')) throw Error();
    } catch {
      error.textContent = t('dialog.argsError');
      return;
    }
  }
  const data = {
    ...Object.fromEntries(
      ['id', 'label', 'description', 'transport', 'command', 'cwd', 'url', 'authMode', 'bearerEnv'].map((k) => [
        k,
        f(k).value
      ])
    ),
    args,
    envKeys: f('envKeys').value.split(/[,\s]+/).filter(Boolean),
    enabled: f('enabled').checked
  };
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const r = await (editing ? update(editing, data) : request('servers', 'POST', data));
    dialog.close();
    await load();
    render();
    toast(r.permissions_reset ? t('toast.savedReset') : t('toast.saved'));
  } catch (err) {
    if (dialog.open) error.textContent = err.message;
    else toast(err.message, true);
  } finally {
    submit.disabled = false;
  }
});

// Curated templates dialog
const templatesDialog = $('#templates-dialog');
const templatesList = $('#templates-list');

function openTemplates(button) {
  originButton = button;
  const existingIds = new Set((state.servers || []).map((s) => s.id));
  templatesList.replaceChildren(
    ...(state.templates || []).map((tpl) => {
      const exists = existingIds.has(tpl.id);
      return el(
        'div',
        { class: 'template-card' },
        el(
          'div',
          { class: 'template-card-head' },
          el('strong', {}, tpl.label),
          pill(tpl.transport === 'http' ? (tpl.authMode === 'oauth' ? 'HTTP · OAuth' : 'HTTP') : 'stdio')
        ),
        el('p', {}, tpl.description),
        actions(
          exists
            ? pill(t('templates.added'), 'ok')
            : btn(
                t('templates.use'),
                () => {
                  templatesDialog.close();
                  openEditor(tpl, button, true);
                },
                'mini primary'
              )
        )
      );
    })
  );
  templatesDialog.showModal();
}

$('#templates-x').onclick = $('#templates-close').onclick = () => templatesDialog.close();
templatesDialog.addEventListener('close', () => originButton?.focus());

// Access Profile editor dialog
const profileDialog = $('#profile-dialog');
const profileForm = $('#profile-form');
const pf = (name) => profileForm.elements.namedItem(name);
let editingProfile = null;

function openProfileEditor(pr, button) {
  editingProfile = pr;
  originButton = button;
  profileForm.reset();
  pf('id').readOnly = !!pr;
  pf('scope').value = pr?.scope || 'selected';
  updateProfileScope();
  if (pr) {
    pf('id').value = pr.id;
    pf('label').value = pr.label || '';
    pf('description').value = pr.description || '';
  }
  $('#profile-title').textContent = pr ? t('profiles.dialogEdit') : t('profiles.dialogAdd');
  $('#profile-error').textContent = '';
  const selected = new Set(pr?.servers || []);
  $('#profile-servers').replaceChildren(
    ...(state.servers || []).map((s) =>
      el(
        'label',
        { class: 'check' },
        el('input', { type: 'checkbox', name: 'srv', value: s.id, checked: selected.has(s.id) }),
        `${s.label} (${s.id})`
      )
    )
  );
  profileDialog.showModal();
}

function updateProfileScope() {
  $('#profile-server-fields').hidden = pf('scope').value !== 'selected';
}

pf('scope').addEventListener('change', updateProfileScope);
$('#profile-x').onclick = $('#profile-cancel').onclick = () => profileDialog.close();
profileDialog.addEventListener('close', () => originButton?.focus());

profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errNode = $('#profile-error');
  errNode.textContent = '';
  const servers = [...profileForm.querySelectorAll('input[name="srv"]:checked')].map((x) => x.value);
  const payload = {
    id: pf('id').value,
    label: pf('label').value,
    description: pf('description').value,
    scope: pf('scope').value,
    servers
  };
  const submit = profileForm.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    if (editingProfile) {
      await request('profiles/' + editingProfile.id, 'PUT', payload);
    } else {
      await request('profiles', 'POST', payload);
    }
    profileDialog.close();
    await load();
    render();
    toast(t('toast.profileSaved'));
  } catch (err) {
    errNode.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

const restoreDialog = $('#restore-dialog');
const restoreForm = $('#restore-form');
const restoreFile = $('#restore-file');
const restoreError = $('#restore-error');

function openRestore(button) {
  originButton = button;
  restoreForm.reset();
  restoreError.textContent = '';
  restoreDialog.showModal();
}

$('#restore-x').onclick = $('#restore-cancel').onclick = () => restoreDialog.close();
restoreDialog.addEventListener('close', () => originButton?.focus());

restoreForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = restoreFile.files[0];
  if (!file || !confirm(t('backup.confirm'))) return;
  const submit = restoreForm.querySelector('[type=submit]');
  submit.disabled = true;
  restoreError.textContent = '';
  try {
    const raw = await file.text();
    let backup;
    try {
      backup = JSON.parse(raw);
    } catch {
      throw new Error(t('backup.invalidJson'));
    }
    await request('restore', 'POST', backup);
    restoreDialog.close();
    await load();
    render();
    toast(t('backup.restored'));
  } catch (err) {
    restoreError.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

// Language switcher
const langSelect = $('#lang-select');
for (const loc of LOCALES) {
  langSelect.append(el('option', { value: loc.code }, loc.label));
}
langSelect.addEventListener('change', async (e) => {
  await setLocale(e.target.value, true);
  applyStaticTranslations();
  updateInstanceChrome();
  if (state || needsLogin) render();
});

async function switchView(nextView, pushHash = true) {
  if (!Object.hasOwn(routeKeys, nextView) || !state) return;
  view = nextView;
  if (pushHash && location.hash !== '#' + view) {
    history.replaceState(null, '', '#' + view);
  }
  if (view === 'logs') {
    try {
      await loadLogs();
    } catch (err) {
      toast(err.message, true);
    }
  }
  syncLogPolling();
  render();
}

document.querySelector('nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) void switchView(b.dataset.view);
});

window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1);
  if (Object.hasOwn(routeKeys, next) && next !== view) {
    void switchView(next, false);
  }
});

document.addEventListener('keydown', (e) => {
  if (
    e.key === '/' &&
    view === 'tools' &&
    !dialog.open &&
    !importDialog.open &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  ) {
    e.preventDefault();
    document.querySelector('input[type="search"]')?.focus();
  }
});

function renderLogin() {
  needsLogin = true;
  updateInstanceChrome();
  const pwd = el('input', {
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    placeholder: t('login.placeholder')
  });
  const errEl = el('p', { class: 'err', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'primary' }, t('login.submit'));
  const loginForm = el(
    'form',
    {
      class: 'login-card',
      on: {
        submit: async (e) => {
          e.preventDefault();
          errEl.textContent = '';
          submit.disabled = true;
          try {
            await request('auth/login', 'POST', { password: pwd.value });
            await boot();
          } catch (err) {
            errEl.textContent = err.message;
          } finally {
            submit.disabled = false;
          }
        }
      }
    },
    el('div', { class: 'kicker' }, t('login.kicker')),
    el('h2', {}, t('login.title')),
    el('p', { class: 'sub' }, t('login.sub')),
    el('label', {}, t('login.password'), pwd),
    errEl,
    actions(submit)
  );
  $('#crumb').textContent = t('login.title');
  $('#content').replaceChildren(el('div', { class: 'login-wrap' }, loginForm));
  $('#content').removeAttribute('aria-busy');
  pwd.focus();
}

async function boot() {
  const initialLang = detectLocale();
  await setLocale(initialLang, false);
  langSelect.value = getLocale();
  applyStaticTranslations();
  try {
    await load();
    if (view === 'logs') await loadLogs();
    syncLogPolling();
    render();
  } catch (e) {
    if (e.status === 401 || e.authRequired) {
      renderLogin();
    } else {
      $('#content').replaceChildren(
        empty(t('error.offlineTitle'), e.message, btn(t('error.retry'), () => location.reload()))
      );
    }
  }
}

await boot();
