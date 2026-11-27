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

const routes = {
  sources: '连接管理',
  tools: '工具目录',
  logs: '调用记录',
  meta: '元工具描述',
  clients: '接入 Agent'
};

const statuses = {
  ready: '已连接',
  disabled: '已停用',
  idle: '未检测',
  error: '连接异常'
};

const logStatuses = {
  ok: ['成功', 'ok'],
  blocked: ['已拦截', 'warn'],
  invalid: ['参数无效', 'warn'],
  upstream_error: ['上游报错', 'bad'],
  error: ['失败', 'bad']
};

let state;
let logs = [];
let view = Object.hasOwn(routes, location.hash.slice(1)) ? location.hash.slice(1) : 'sources';
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
    const err = Error(j.error || '请求未完成');
    err.status = r.status;
    err.authRequired = !!j.auth_required;
    throw err;
  }
  return j;
}

async function load() {
  state = await request('state');
  const tag = $('#instance-tag');
  if (tag) {
    const prefix = state.mode === 'remote' ? '远程实例' : state.demo ? '仅本机 · Demo' : '仅本机';
    tag.textContent = state.mode === 'remote' && state.publicUrl ? prefix : `${prefix} · :${state.port}`;
  }
  const modeLabel = $('#mode-label');
  if (modeLabel) {
    modeLabel.textContent = state.mode === 'remote' ? '远程实例' : '本地实例';
  }
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
    const t = Array.isArray(prop?.type) ? prop.type[0] : prop?.type;
    if (prop?.default !== undefined) obj[key] = prop.default;
    else if (Array.isArray(prop?.enum) && prop.enum.length) obj[key] = prop.enum[0];
    else if (t === 'string') obj[key] = '';
    else if (t === 'number' || t === 'integer') obj[key] = 0;
    else if (t === 'boolean') obj[key] = false;
    else if (t === 'array') obj[key] = [];
    else if (t === 'object') obj[key] = {};
    else obj[key] = '';
  }
  return JSON.stringify(obj, null, 2);
}

function annotationBadges(annotations) {
  if (!annotations || typeof annotations !== 'object') return [];
  const badges = [];
  if (annotations.readOnlyHint === true) {
    badges.push(el('span', { class: 'badge', title: '上游声明：只读（仅供参考，不作为权限依据）' }, '只读'));
  }
  if (annotations.destructiveHint === true) {
    badges.push(el('span', { class: 'badge warn', title: '上游声明：可能有破坏性（仅供参考）' }, '破坏性'));
  }
  if (annotations.idempotentHint === true) {
    badges.push(el('span', { class: 'badge', title: '上游声明：幂等（仅供参考）' }, '幂等'));
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
      ['已配置连接', all.length],
      [
        '已发现且开放的工具',
        all
          .filter((s) => s.enabled)
          .reduce((n, s) => n + s.tools.filter((t) => s.allowlist.includes(t.name)).length, 0)
      ],
      ['Agent 元工具', state.meta.length]
    ].map(([l, n]) => el('div', { class: 'metric' }, l, el('b', {}, String(n).padStart(2, '0'))))
  );

  const rows = all.map((s) => {
    const allowedCount = s.tools.filter((t) => s.allowlist.includes(t.name)).length;
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
            `${s.id} · ${s.transport === 'stdio' ? 'stdio' : 'Streamable HTTP'} · ${s.tools.length} 个已发现 · ${allowedCount} 个已开放`
          ),
          s.description ? el('p', {}, s.description) : null,
          s.missingEnvKeys?.length
            ? el(
                'div',
                { class: 'warn-note' },
                '当前环境未设置变量：' + s.missingEnvKeys.join(', ')
              )
            : null,
          s.error ? el('div', { class: 'err' }, s.error) : null
        )
      ),
      actions(
        pill(statuses[s.status], s.status === 'ready' ? 'ok' : s.status === 'error' ? 'bad' : ''),
        s.enabled
          ? btn(
              '读取工具',
              (e) => run(e, () => request('servers/' + s.id + '/refresh', 'POST'), '已刷新目录'),
              'mini'
            )
          : null,
        btn('编辑', (e) => openEditor(s, e.currentTarget), 'mini'),
        btn(
          s.enabled ? '停用' : '启用',
          (e) =>
            run(
              e,
              () => update(s, { enabled: !s.enabled }),
              s.enabled ? '连接已停用' : '连接已启用'
            ),
          'mini'
        )
      )
    );
  });

  const panelExtra = actions(
    el('span', { class: 'sub' }, all.length + ' 个连接'),
    all.length
      ? btn(
          '导出 JSON',
          async () => {
            try {
              const data = await request('export');
              const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = el('a', { href: url, download: 'mcp-shelf-servers.json' });
              a.click();
              URL.revokeObjectURL(url);
              toast('已导出脱敏连接配置（不含本机 Token）。');
            } catch (err) {
              toast(err.message, true);
            }
          },
          'mini'
        )
      : null,
    hasEnabled
      ? btn(
          '全部刷新',
          (e) =>
            run(
              e,
              () => request('servers/refresh-all', 'POST'),
              (res) => {
                const okCount = (res.results || []).filter((r) => r.status === 'ready').length;
                return `已刷新 ${res.results?.length || 0} 个连接（${okCount} 个就绪）`;
              }
            ),
          'mini'
        )
      : null
  );

  return [
    hero(
      'WORKSPACE / CONNECTIONS',
      '连接管理',
      '一次配置上游 MCP，各个 Agent 共用同一套工具目录。',
      actions(
        btn('导入配置', (e) => openImport(e.currentTarget)),
        btn('＋ 添加连接', (e) => openEditor(null, e.currentTarget), 'primary')
      )
    ),
    metrics,
    panel(
      '上游 MCP',
      panelExtra,
      rows.length
        ? rows
        : empty(
            '还没有连接',
            '添加可信本地进程或 Streamable HTTP 端点，或直接导入已有客户端配置。',
            btn('加载离线示例', (e) => run(e, () => request('demo', 'POST'), '已加载离线示例'))
          )
    ),
    hint('新工具默认不对 Agent 开放。读完目录后，在「工具目录」逐个允许或在线试调。')
  ];
}

function batchToggle(rows, allow) {
  const byServer = new Map();
  for (const { s, t } of rows) {
    if (!s.enabled) continue;
    const set = byServer.get(s.id) || { s, names: new Set(s.allowlist) };
    if (allow) set.names.add(t.name);
    else set.names.delete(t.name);
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
    .flatMap((s) => s.tools.map((t) => ({ s, t })))
    .filter(
      ({ s, t }) =>
        (!allowOnly || (s.enabled && s.allowlist.includes(t.name))) &&
        (!needle ||
          (t.tool_id + ' ' + t.description + ' ' + s.label)
            .normalize('NFKC')
            .toLowerCase()
            .includes(needle))
    );

  const countLabel = rows.length > 300 ? '前 300／' + rows.length : rows.length + ' 项';
  const enabledRows = rows.filter(({ s }) => s.enabled);
  const canAllowAny = enabledRows.some(({ s, t }) => !s.allowlist.includes(t.name));
  const canRevokeAny = enabledRows.some(({ s, t }) => s.allowlist.includes(t.name));

  const headExtra = actions(
    el('span', { class: 'sub' }, countLabel),
    canAllowAny
      ? btn(
          '全部允许',
          (e) => {
            if (!confirm(`确认将当前筛选出的 ${enabledRows.length} 个工具全部对 Agent 开放？`)) return;
            const tasks = batchToggle(enabledRows, true);
            run(
              e,
              async () => {
                for (const fn of tasks) await fn();
              },
              '已批量开放所选工具'
            );
          },
          'mini'
        )
      : null,
    canRevokeAny
      ? btn(
          '全部撤销',
          (e) => {
            if (!confirm(`确认撤销当前筛选出的工具授权？`)) return;
            const tasks = batchToggle(enabledRows, false);
            run(
              e,
              async () => {
                for (const fn of tasks) await fn();
              },
              '已批量撤销授权'
            );
          },
          'mini'
        )
      : null
  );

  body.replaceChildren(
    panel(
      '匹配工具',
      headExtra,
      rows.length
        ? rows.slice(0, 300).map(({ s, t }) => {
            const has = s.allowlist.includes(t.name);
            const isOpen = expandedTools.has(t.tool_id);
            const area = el('textarea', {
              'aria-label': '覆盖 ' + t.tool_id + ' 的描述',
              value: s.overrides[t.name] || '',
              maxlength: 2400,
              rows: 3,
              placeholder: '留空使用上游描述'
            });

            const defaultArgs = tryArgsCache.has(t.tool_id)
              ? tryArgsCache.get(t.tool_id)
              : skeletonFromSchema(t.inputSchema);
            let tryBtn;
            const tryInput = el('textarea', {
              'aria-label': '试调 ' + t.tool_id + ' 的 JSON 参数',
              class: 'mono',
              rows: 3,
              value: defaultArgs,
              on: {
                input: (e) => {
                  tryArgsCache.set(t.tool_id, e.target.value);
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
              const res = tryResults.get(t.tool_id);
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
                    el('strong', {}, isErr ? '试调返回错误' : '试调成功'),
                    res.durationMs != null ? ` · ${res.durationMs} ms` : ''
                  ),
                  el('pre', {}, typeof res.body === 'string' ? res.body : JSON.stringify(res.body, null, 2))
                )
              );
            };
            renderTryResult();

            const resetArgsBtn = btn(
              '重置参数',
              () => {
                const sk = skeletonFromSchema(t.inputSchema);
                tryInput.value = sk;
                tryArgsCache.set(t.tool_id, sk);
              },
              'mini'
            );

            tryBtn = btn(
              '试调工具',
              async (e) => {
                let parsedArgs;
                try {
                  parsedArgs = JSON.parse(tryInput.value.trim() || '{}');
                  if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
                    throw Error('参数必须是 JSON 对象');
                  }
                } catch (err) {
                  tryResults.set(t.tool_id, { isError: true, body: '参数 JSON 格式错误：' + err.message });
                  renderTryResult();
                  return;
                }
                const target = e.currentTarget;
                target.disabled = true;
                try {
                  const res = await request('tools/test', 'POST', {
                    tool_id: t.tool_id,
                    arguments: parsedArgs
                  });
                  tryResults.set(t.tool_id, {
                    isError: !!res.result?.isError,
                    durationMs: res.durationMs,
                    result: res.result,
                    body: res.result?.structuredContent ?? res.result?.content ?? res.result
                  });
                  renderTryResult();
                } catch (err) {
                  tryResults.set(t.tool_id, { isError: true, body: err.message });
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
                    if (e.currentTarget.open) expandedTools.add(t.tool_id);
                    else expandedTools.delete(t.tool_id);
                  }
                }
              },
              el('summary', {}, '参数和描述'),
              el(
                'p',
                { class: 'sub' },
                t.schemaHash ? `输入 JSON Schema（指纹 ${t.schemaHash}）` : '输入 JSON Schema'
              ),
              el('pre', { class: 'snippet' }, JSON.stringify(t.inputSchema, null, 2)),
              t.outputSchema
                ? el(
                    'div',
                    {},
                    el('p', { class: 'sub' }, '输出 JSON Schema'),
                    el('pre', { class: 'snippet' }, JSON.stringify(t.outputSchema, null, 2))
                  )
                : null,
              el('label', {}, '自定义描述', area),
              btn(
                '保存描述',
                (e) =>
                  run(
                    e,
                    () => update(s, { overrides: { ...s.overrides, [t.name]: area.value } }),
                    '描述已保存'
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
                      el('span', { class: 'sub' }, '在线试调（Cmd/Ctrl + Enter 快速执行）'),
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
                    el('h2', { class: 'mono' }, t.tool_id),
                    ...annotationBadges(t.annotations)
                  ),
                  el('p', {}, t.description || '上游未提供描述。')
                ),
                actions(
                  pill(has && s.enabled ? 'Agent 可调用' : '不对 Agent 开放', has && s.enabled ? 'ok' : ''),
                  btn(
                    has ? '撤销' : '允许',
                    (e) =>
                      run(
                        e,
                        () =>
                          update(s, {
                            allowlist: has
                              ? s.allowlist.filter((n) => n !== t.name)
                              : [...s.allowlist, t.name]
                          }),
                        has ? '已撤销授权' : '已对 Agent 开放'
                      ),
                    'mini'
                  )
                )
              ),
              detailsEl
            );
          })
        : empty('没有匹配的工具', '先读取一个上游工具目录，或调整筛选条件。')
    )
  );
}

function tools() {
  const body = el('div');
  toolRows(body);
  const input = el('input', {
    type: 'search',
    'aria-label': '搜索工具',
    placeholder: '搜索名称、描述或连接…',
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
      'aria-label': '筛选连接',
      on: {
        change: (e) => {
          filter = e.target.value;
          toolRows(body);
        }
      }
    },
    el('option', { value: '' }, '全部连接'),
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
    '只看已开放'
  );
  return [
    hero('WORKSPACE / CATALOG', '工具目录', '搜索工具、预览参数，逐个控制 Agent 能发现和调用什么。'),
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
      return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
    } catch {
      return iso;
    }
  };

  const filtered = logs.filter((item) => !logSourceFilter || item.source === logSourceFilter);

  const rows = filtered.map((item) => {
    const [label, cls] = logStatuses[item.status] || [item.status, ''];
    return el(
      'article',
      { class: 'log-row' },
      el(
        'div',
        { class: 'log-main' },
        el(
          'div',
          { class: 'log-title' },
          pill(item.source === 'playground' ? '试调' : 'Agent'),
          el('strong', { class: 'mono' }, item.action),
          el('code', { class: 'sub' }, item.target)
        ),
        item.detail ? el('div', { class: 'sub' }, item.detail) : null
      ),
      el(
        'div',
        { class: 'log-meta' },
        pill(label, cls),
        el('span', { class: 'mono' }, `${item.durationMs} ms`),
        el('span', { class: 'mono' }, formatTime(item.at))
      )
    );
  });

  const sourceSelect = el(
    'select',
    {
      'aria-label': '筛选来源',
      style: 'width:auto',
      on: {
        change: (e) => {
          logSourceFilter = e.target.value;
          render();
        }
      }
    },
    el('option', { value: '' }, '全部来源'),
    el('option', { value: 'agent' }, '仅 Agent'),
    el('option', { value: 'playground' }, '仅试调')
  );
  sourceSelect.value = logSourceFilter;

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
    '自动刷新 (3s)'
  );

  return [
    hero(
      'WORKSPACE / ACTIVITY',
      '调用记录',
      '查看本机网关内存中最近的 Agent 工具发现、调用与拦截记录（重启后自动清空，不落盘敏感参数）。',
      actions(
        autoCheck,
        btn('刷新记录', (e) => run(e, () => loadLogs(), '已刷新调用记录')),
        logs.length
          ? btn(
              '清空记录',
              (e) => run(e, () => request('logs', 'DELETE'), '调用记录已清空'),
              'danger'
            )
          : null
      )
    ),
    panel(
      '最近活动',
      actions(sourceSelect, el('span', { class: 'sub' }, `${filtered.length} / ${logs.length} 条`)),
      rows.length
        ? rows
        : empty('暂无调用记录', '当 Agent 通过 MCP Shelf 查询或调用工具，或在「工具目录」试调后，这里会显示实时记录。')
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
        el(
          'p',
          {},
          m.name === 'call_tool'
            ? '建议保留副作用及用户确认要求。'
            : '文案不改变工具名、参数或权限。'
        ),
        input
      )
    );
  });
  const save = btn(
    '保存元工具描述',
    (e) =>
      run(
        e,
        () =>
          request(
            'descriptions',
            'PUT',
            Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, v.value]))
          ),
        '元工具描述已保存'
      ),
    'primary'
  );
  const fill = btn('恢复默认文案', () => {
    for (const [k, v] of Object.entries(areas)) v.value = state.defaults[k];
    toast('已填入默认文案，保存后生效。');
  });
  const reminderPanel = panel(
    '实时服务摘要预览（自动注入给 Agent）',
    pill('指纹 ' + (state.fingerprint || '—'), 'ok'),
    el(
      'div',
      { class: 'inside' },
      el(
        'p',
        {},
        '以下精简清单会自动附带在 MCP 握手 instructions 及 list_mcps / search_tool 描述中，让 Agent 开局即可感知已挂载服务；修改连接或授权后将通过 tools/list_changed 自动通知客户端。'
      ),
      el(
        'pre',
        { class: 'snippet' },
        state.serverReminder || '（当前尚无已启用且已开放工具的连接）'
      )
    )
  );
  return [
    hero('SETTINGS / META-TOOLS', '元工具描述', '自定义三个元工具在 Agent 里显示的文案。', save),
    el('div', { class: 'stack' }, reminderPanel, ...cards),
    hint('变更会自动触发 tools/list_changed 通知；不支持热刷新的客户端请重新连接或打开新会话。'),
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
        '复制',
        async () => {
          try {
            await navigator.clipboard.writeText(content);
            toast('已复制');
          } catch {
            toast('复制失败，请手动选择文本。', true);
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
    state.mode === 'remote' ? '远端实例与访问凭证' : '当前实例信息',
    actions(
      pill(state.mode === 'remote' ? '远程模式' : '127.0.0.1:' + state.port, 'ok'),
      state.mode === 'remote'
        ? btn(
            '退出登录',
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
      el('p', {}, '配置文件路径（权限 0600，Bearer Token 保存在此文件中）：'),
      el('code', { class: 'mono' }, state.configFile || '~/.config/mcp-shelf/config.json'),
      state.mode === 'remote'
        ? el(
            'div',
            { style: 'margin-top:12px' },
            actions(
              btn(
                '显示并复制 MCP Token',
                async (e) => {
                  const target = e.currentTarget;
                  target.disabled = true;
                  try {
                    const res = await request('token', 'POST');
                    tokenBox.replaceChildren(el('pre', { class: 'snippet' }, res.token));
                    try {
                      await navigator.clipboard.writeText(res.token);
                      toast('已显示并复制 MCP Bearer Token');
                    } catch {
                      toast('已显示 MCP Bearer Token，请手动复制');
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
                '轮换 Token',
                async (e) => {
                  if (!confirm('确认轮换 MCP Bearer Token？轮换后旧设备将立即失效，需更新为新 Token。')) return;
                  const target = e.currentTarget;
                  target.disabled = true;
                  try {
                    const res = await request('token/rotate', 'POST');
                    tokenBox.replaceChildren(el('pre', { class: 'snippet' }, res.token));
                    toast('Token 已轮换，旧凭证已失效。');
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
            '远端 Streamable HTTP（跨设备通用）',
            '在任意设备的 MCP 客户端直连此端点，配合 Bearer Token 鉴权（建议前置于 Caddy / NPM HTTPS 反代）。',
            remoteUrl + '\nAuthorization: Bearer <MCP_SHELF_TOKEN>'
          ),
          snippet(
            'Grok Build（连接此远端服务器）',
            '在任意电脑终端执行，将 MCP_SHELF_TOKEN 设为上方 Token。',
            `grok mcp add --transport http mcp_shelf ${quote(remoteUrl)} --header 'Authorization: Bearer \${MCP_SHELF_TOKEN}'`
          ),
          snippet(
            'Claude Code（连接此远端服务器）',
            '在任意电脑终端添加远端 HTTP MCP。',
            `claude mcp add --transport http mcp-shelf ${quote(remoteUrl)} --header 'Authorization: Bearer <MCP_SHELF_TOKEN>'`
          )
        ]
      : [];

  return [
    hero('SETTINGS / CLIENTS', '接入 Agent', '保持网关运行，每个客户端只注册 MCP Shelf。'),
    el(
      'div',
      { class: 'stack' },
      tokenPanel,
      ...remoteSnippets,
      snippet('Grok Build（本机 stdio）', '在终端注册本机 stdio Bridge 到 ~/.grok/config.toml。', gr),
      snippet('Codex（本机 stdio）', '将片段合并到 Codex 的 config.toml。', toml),
      snippet('Claude Code（本机 stdio）', '在终端添加 stdio Bridge。', cl),
      snippet(
        'Google Antigravity',
        '在 Manage MCP Servers 打开原始配置，合并 mcpServers 里的这一项。',
        JSON.stringify({ mcpServers: { 'mcp-shelf': config } }, null, 2)
      ),
      snippet(
        'Streamable HTTP（本机直连）',
        '支持自定义请求头的 MCP 客户端可直连；Bearer 取自本机 config.json。',
        'http://127.0.0.1:' + state.port + '/mcp\nAuthorization: Bearer <LOCAL_CONFIG_TOKEN>'
      )
    )
  ];
}

function render() {
  $('#crumb').textContent = routes[view];
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
  $('#form-title').textContent = s ? '编辑连接' : '添加连接';
  $('#error').textContent = '';
  $('#delete-source')?.remove();
  if (s) {
    const remove = btn(
      '删除连接',
      (e) => {
        if (confirm('删除此本地连接？上游服务不会被修改。')) {
          dialog.close();
          void run(e, () => request('servers/' + s.id, 'DELETE'), '连接已删除');
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
      error.textContent = '参数必须是 JSON 字符串数组。';
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
    toast(r.permissions_reset ? '连接已保存，旧工具授权已清除。' : '连接已保存。');
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
            pill(conflict ? '已存在，将跳过' : '将导入', conflict ? 'warn' : 'ok')
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
            pill('跳过', 'bad')
          ),
          el('div', { class: 'sub' }, s.reason)
        )
      )
    );
    importPreview.replaceChildren(
      el('div', { class: 'sub' }, `识别格式：${res.format.toUpperCase()} · 可导入 ${res.items.filter((x) => !x.conflict).length} 项`),
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
        ? `已导入 ${res.imported.length} 个连接（${res.imported.join(', ')}）`
        : '没有新连接可导入（可能均已存在或被跳过）。',
      !res.imported.length
    );
  } catch (err) {
    importError.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

async function switchView(nextView, pushHash = true) {
  if (!Object.hasOwn(routes, nextView) || !state) return;
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
  if (Object.hasOwn(routes, next) && next !== view) {
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
  const pwd = el('input', {
    type: 'password',
    required: true,
    autocomplete: 'current-password',
    placeholder: '输入 MCP_SHELF_ADMIN_PASSWORD'
  });
  const errEl = el('p', { class: 'err', role: 'alert' });
  const submit = el('button', { type: 'submit', class: 'primary' }, '解锁工作台');
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
    el('div', { class: 'kicker' }, 'REMOTE WORKBENCH'),
    el('h2', {}, '登录 MCP Shelf 管理台'),
    el('p', { class: 'sub' }, '当前实例运行在远程模式，需要管理密码解锁。'),
    el('label', {}, '管理密码', pwd),
    errEl,
    actions(submit)
  );
  $('#crumb').textContent = '身份验证';
  $('#content').replaceChildren(el('div', { class: 'login-wrap' }, loginForm));
  $('#content').removeAttribute('aria-busy');
  pwd.focus();
}

async function boot() {
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
        empty('无法连接本地网关', e.message, btn('重试', () => location.reload()))
      );
    }
  }
}

await boot();
