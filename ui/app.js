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
  if (!state) return;
  const tag = $('#instance-tag');
  if (tag) {
    const prefix =
      state.mode === 'remote'
        ? t('top.remote')
        : state.demo
          ? t('top.localDemo')
          : t('top.local');
    tag.textContent = state.mode === 'remote' && state.publicUrl ? prefix : `${prefix} · :${state.port}`;
  }
  const modeLabel = $('#mode-label');
  if (modeLabel) {
    modeLabel.textContent = state.mode === 'remote' ? t('footer.remote') : t('footer.local');
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

const update = ({ tools, status, error, missingEnvKeys, ...s }, more) =>
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
    all.length
      ? btn(
          t('sources.export'),
          async () => {
            try {
              const data = await request('export');
              const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = el('a', { href: url, download: 'mcp-shelf-servers.json' });
              a.click();
              URL.revokeObjectURL(url);
              toast(t('toast.exported'));
            } catch (err) {
              toast(err.message, true);
            }
          },
          'mini'
        )
      : null,
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
        btn(t('sources.import'), (e) => openImport(e.currentTarget)),
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
            btn(t('sources.loadDemo'), (e) => run(e, () => request('demo', 'POST'), t('toast.demoLoaded')))
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
                    el('h2', { class: 'mono' }, tl.tool_id),
                    ...annotationBadges(tl.annotations)
                  ),
                  el('p', {}, tl.description || t('tools.noDesc'))
                ),
                actions(
                  pill(has && s.enabled ? t('tools.allowed') : t('tools.blocked'), has && s.enabled ? 'ok' : ''),
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

  const settingsBar = el(
    'div',
    { class: 'settings-bar' },
    el('label', { class: 'settings-field' }, t('logs.maxEntries'), limitSelect),
    detailsCheck,
    el('label', { class: 'settings-field' }, t('logs.idleLabel'), idleSelect)
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

function snippet(title, description, content) {
  return panel(
    title,
    null,
    el(
      'div',
      { class: 'inside' },
      el('p', {}, description),
      el('pre', { class: 'snippet' }, content),
      btn(
        t('clients.copy'),
        async () => {
          try {
            await navigator.clipboard.writeText(content);
            toast(t('toast.copied'));
          } catch {
            toast(t('toast.copyFailed'), true);
          }
        },
        'mini'
      )
    )
  );
}

function clients() {
  const b = state.bridge;
  const kv = Object.entries(b.env);
  const config = { command: b.command, args: b.args, ...(kv.length ? { env: b.env } : {}) };
  const toml = [
    '[mcp_servers.mcp_shelf]',
    'command = ' + JSON.stringify(b.command),
    'args = ' + JSON.stringify(b.args),
    ...(kv.length
      ? ['', '[mcp_servers.mcp_shelf.env]', ...kv.map(([k, v]) => k + ' = ' + JSON.stringify(v))]
      : [])
  ].join('\n');
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const cl = [
    'claude',
    'mcp',
    'add',
    '--transport',
    'stdio',
    'mcp-shelf',
    ...kv.flatMap(([k, v]) => ['--env', quote(k + '=' + v)]),
    '--',
    quote(b.command),
    ...b.args.map(quote)
  ].join(' ');
  const gr = [
    'grok',
    'mcp',
    'add',
    'mcp_shelf',
    ...kv.flatMap(([k, v]) => ['-e', quote(k + '=' + v)]),
    '--',
    quote(b.command),
    ...b.args.map(quote)
  ].join(' ');

  const remoteUrl = state.remoteEndpoint || 'http://127.0.0.1:' + state.port + '/mcp';
  const tokenBox = el('div');
  const tokenPanel = panel(
    state.mode === 'remote' ? t('clients.infoRemote') : t('clients.infoLocal'),
    actions(
      pill(state.mode === 'remote' ? t('clients.remoteMode') : '127.0.0.1:' + state.port, 'ok'),
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
      el('p', {}, t('clients.configPath')),
      el('code', { class: 'mono' }, state.configFile || '~/.config/mcp-shelf/config.json'),
      state.mode === 'remote'
        ? el(
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
        : null
    )
  );

  const remoteSnippets =
    state.mode === 'remote'
      ? [
          snippet(
            t('clients.remoteHttpTitle'),
            t('clients.remoteHttpDesc'),
            remoteUrl + '\nAuthorization: Bearer <MCP_SHELF_TOKEN>'
          ),
          snippet(
            t('clients.remoteGrokTitle'),
            t('clients.remoteGrokDesc'),
            `grok mcp add --transport http mcp_shelf ${quote(remoteUrl)} --header 'Authorization: Bearer \${MCP_SHELF_TOKEN}'`
          ),
          snippet(
            t('clients.remoteClaudeTitle'),
            t('clients.remoteClaudeDesc'),
            `claude mcp add --transport http mcp-shelf ${quote(remoteUrl)} --header 'Authorization: Bearer <MCP_SHELF_TOKEN>'`
          )
        ]
      : [];

  return [
    hero(t('clients.kicker'), t('clients.title'), t('clients.sub')),
    el(
      'div',
      { class: 'stack' },
      tokenPanel,
      ...remoteSnippets,
      snippet(t('clients.grokTitle'), t('clients.grokDesc'), gr),
      snippet(t('clients.codexTitle'), t('clients.codexDesc'), toml),
      snippet(t('clients.claudeTitle'), t('clients.claudeDesc'), cl),
      snippet(
        t('clients.agyTitle'),
        t('clients.agyDesc'),
        JSON.stringify({ mcpServers: { 'mcp-shelf': config } }, null, 2)
      ),
      snippet(
        t('clients.localHttpTitle'),
        t('clients.localHttpDesc'),
        'http://127.0.0.1:' + state.port + '/mcp\nAuthorization: Bearer <LOCAL_CONFIG_TOKEN>'
      )
    )
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
}

function openEditor(s, button) {
  editing = s;
  originButton = button;
  form.reset();
  f('id').readOnly = !!s;
  for (const k of ['id', 'label', 'description', 'transport', 'command', 'cwd', 'url', 'bearerEnv']) {
    if (s?.[k]) f(k).value = s[k];
  }
  f('enabled').checked = s ? s.enabled : true;
  f('args').value = s?.args ? JSON.stringify(s.args) : '';
  f('envKeys').value = s?.envKeys?.join(', ') || '';
  $('#form-title').textContent = s ? t('dialog.editTitle') : t('dialog.addTitle');
  $('#error').textContent = '';
  $('#delete-source')?.remove();
  if (s) {
    const remove = btn(
      t('dialog.delete'),
      (e) => {
        if (confirm(t('dialog.confirmDelete'))) {
          dialog.close();
          void run(e, () => request('servers/' + s.id, 'DELETE'), t('toast.deleted'));
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
      ['id', 'label', 'description', 'transport', 'command', 'cwd', 'url', 'bearerEnv'].map((k) => [
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

// Import config dialog
const importDialog = $('#import-dialog');
const importForm = $('#import-form');
const importText = $('#import-text');
const importPreview = $('#import-preview');
const importError = $('#import-error');

function openImport(button) {
  originButton = button;
  importForm.reset();
  importPreview.hidden = true;
  importPreview.replaceChildren();
  importError.textContent = '';
  importDialog.showModal();
}

$('#import-x').onclick = $('#import-cancel').onclick = () => importDialog.close();
importDialog.addEventListener('close', () => originButton?.focus());

$('#import-check').addEventListener('click', async () => {
  importError.textContent = '';
  importPreview.hidden = true;
  try {
    const res = await request('import/preview', 'POST', { text: importText.value });
    const list = el(
      'div',
      { class: 'import-list' },
      ...res.items.map(({ server, warnings, conflict }) =>
        el(
          'div',
          { class: 'import-item' },
          el(
            'div',
            { class: 'import-item-head' },
            el('strong', { class: 'mono' }, `${server.id} (${server.transport})`),
            pill(conflict ? t('import.conflict') : t('import.willImport'), conflict ? 'warn' : 'ok')
          ),
          el('div', { class: 'sub mono' }, server.transport === 'stdio' ? server.command : server.url),
          ...warnings.map((w) => el('div', { class: 'warn-note' }, w))
        )
      ),
      ...res.skipped.map((s) =>
        el(
          'div',
          { class: 'import-item' },
          el(
            'div',
            { class: 'import-item-head' },
            el('strong', { class: 'mono' }, s.id),
            pill(t('import.skipped'), 'bad')
          ),
          el('div', { class: 'sub' }, s.reason)
        )
      )
    );
    importPreview.replaceChildren(
      el(
        'div',
        { class: 'sub' },
        t('import.summary', {
          format: res.format.toUpperCase(),
          count: res.items.filter((x) => !x.conflict).length
        })
      ),
      list
    );
    importPreview.hidden = false;
  } catch (err) {
    importError.textContent = err.message;
  }
});

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  importError.textContent = '';
  const submit = $('#import-submit');
  submit.disabled = true;
  try {
    const res = await request('import', 'POST', { text: importText.value });
    importDialog.close();
    await load();
    render();
    toast(
      res.imported.length
        ? t('toast.imported', { count: res.imported.length, ids: res.imported.join(', ') })
        : t('toast.importNone'),
      !res.imported.length
    );
  } catch (err) {
    importError.textContent = err.message;
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
