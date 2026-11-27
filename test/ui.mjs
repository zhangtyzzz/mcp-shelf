import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { launch, httpClient } from '../src/main.mjs';

function detectBrowser() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ui-'));
const app = await launch({ dir, port: 0, demo: true });
const c = new Client({ name: 'ui-test', version: '1' });
let browser;
let oauthApp;

try {
  browser = await chromium.launch({ headless: true, executablePath: detectBrowser() });
  const p = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // Default locale is English
  await p.goto(app.url);
  await p.getByRole('heading', { name: 'Connections', exact: true }).waitFor();

  // Verify live i18n switching (en -> zh-CN -> en)
  await p.locator('#lang-select').selectOption('zh-CN');
  await p.getByRole('heading', { name: '连接管理', exact: true }).waitFor();
  await p.locator('#lang-select').selectOption('en');
  await p.getByRole('heading', { name: 'Connections', exact: true }).waitFor();

  await p.getByRole('button', { name: 'Fetch Tools', exact: true }).click();
  await p.getByText('Connected', { exact: true }).waitFor();

  // Tools view: edit description (details stays open across save), search, and playground test
  await p.getByRole('button', { name: /Tool Catalog/ }).click();
  const echo = p.locator('.tool').filter({ has: p.getByRole('heading', { name: 'demo/echo', exact: true }) });
  await echo.getByText('Allowed', { exact: true }).waitFor();
  await echo.getByText('Schema & Playground', { exact: true }).click();
  await echo.getByRole('textbox', { name: 'Override description for demo/echo' }).fill('Echo <img src=x onerror=alert(1)>');
  await echo.getByRole('button', { name: 'Save Description', exact: true }).click();
  await echo.getByText('Echo <img src=x onerror=alert(1)>', { exact: true }).waitFor();
  assert.equal(await echo.locator('img').count(), 0);

  await p.getByRole('searchbox', { name: 'Search tools' }).fill('Echo');
  assert.equal(await p.locator('.tool').count(), 1);
  // Details remains open after save/filter
  await echo
    .getByRole('textbox', { name: 'Override description for demo/echo' })
    .fill('Echo a given string for end-to-end verification.');
  await echo.getByRole('button', { name: 'Save Description', exact: true }).click();
  await echo.getByText('Echo a given string for end-to-end verification.', { exact: true }).waitFor();

  // Playground test call
  await echo.getByRole('textbox', { name: 'JSON arguments for demo/echo' }).fill('{"text":"UI Playground"}');
  await echo.getByRole('button', { name: 'Run Tool', exact: true }).click();
  await echo.getByText('Succeeded', { exact: true }).waitFor();
  await echo.getByText('UI Playground').waitFor();

  await p.getByRole('searchbox', { name: 'Search tools' }).fill('');
  if (process.env.SHELF_SHOT) await p.screenshot({ path: process.env.SHELF_SHOT, fullPage: true });

  // Meta-tool descriptions
  await p.getByRole('button', { name: /Meta-Tools/ }).click();
  await p.getByRole('textbox', { name: 'search_tool', exact: true }).fill('Custom search description');
  await p.getByRole('button', { name: 'Save Descriptions' }).click();
  await p.getByText('Meta-tool descriptions saved', { exact: true }).waitFor();

  // Live MCP client verification
  await c.connect(httpClient(app.url + '/mcp', { Authorization: 'Bearer ' + app.config.get().token }));
  const listedTools = await c.listTools();
  assert.ok(listedTools.tools[1].description.startsWith('Custom search description'));
  assert.match(listedTools.tools[1].description, /Connected MCP servers:\n- demo \(2 tools\):/);
  assert.deepEqual(
    (await c.callTool({ name: 'call_tool', arguments: { tool_id: 'demo/echo', arguments: { text: 'UI → MCP' } } }))
      .structuredContent,
    { echo: 'UI → MCP' }
  );

  // Activity logs view
  await p.getByRole('button', { name: /Activity/ }).click();
  await p.getByRole('heading', { name: 'Activity Log', exact: true }).waitFor();
  assert.ok((await p.locator('.log-row').count()) >= 2);
  await p.getByRole('button', { name: 'Clear', exact: true }).click();
  await p.getByText('No activity yet', { exact: true }).waitFor();

  // Clients view: segmented controls (Mode x Client) & Access Profile creation + mobile layout check
  await p.getByRole('button', { name: /Connect Agents/ }).click();
  await p.getByRole('tab', { name: 'Google Antigravity', exact: true }).click();
  await p.getByText('"mcpServers"').waitFor();
  await p.getByRole('tab', { name: 'OAuth 2.1', exact: true }).click();
  await p.getByText('grok mcp add --transport http').waitFor();
  await p.getByRole('button', { name: '+ New Profile' }).click();
  const pd = p.getByRole('dialog');
  await pd.getByLabel('Profile ID').fill('vps-demo');
  await pd.getByLabel('Display Name').fill('VPS Demo');
  await pd.getByRole('button', { name: 'Save Profile' }).click();
  await p.getByText('VPS Demo', { exact: true }).waitFor();

  await p.setViewportSize({ width: 390, height: 844 });
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  // Curated Templates dialog (Exa Search)
  await p.getByRole('button', { name: /Connections/ }).click();
  await p.getByRole('button', { name: 'Templates', exact: true }).click();
  const td = p.getByRole('dialog');
  await td.getByText('Exa Search (Free)', { exact: true }).waitFor();
  await td.getByRole('button', { name: 'Cancel', exact: true }).click();
  await p.getByRole('button', { name: /Add Connection/ }).click();
  const d = p.getByRole('dialog');
  await d.getByLabel('Connection ID').fill('sleeping-http');
  await d.getByLabel('Display Name').fill('Test Server');
  await d.getByLabel('Transport').selectOption('http');
  await d.getByLabel('Streamable HTTP URL').fill('http://127.0.0.1:9/mcp');
  await d.getByLabel('Enable connection').uncheck();
  await d.getByRole('button', { name: 'Save Connection' }).click();
  await p.getByText('Test Server', { exact: true }).waitFor();
  assert.equal(await p.getByText('Disabled', { exact: true }).count(), 1);

  // Import connection via dialog
  await p.getByRole('button', { name: 'Import', exact: true }).click();
  const imp = p.getByRole('dialog');
  await imp
    .locator('#import-text')
    .fill(JSON.stringify({ mcpServers: { 'imported-http': { url: 'https://example.com/mcp', enabled: false } } }));
  await imp.getByRole('button', { name: 'Preview', exact: true }).click();
  await imp.getByText('Will import', { exact: true }).waitFor();
  await imp.getByRole('button', { name: 'Import', exact: true }).click();
  await p.getByText('imported-http', { exact: true }).waitFor();

  // OAuth uses a native browser form, so Chromium controls the Origin header.
  const adminPassword = 'browser-test-password';
  oauthApp = await launch({ dir: path.join(dir, 'remote'), port: 0, mode: 'remote', host: '127.0.0.1', adminPassword });
  const callback = app.url + '/healthz';
  const registration = await fetch(oauthApp.url + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Browser OAuth Test', redirect_uris: [callback] })
  });
  assert.equal(registration.status, 201);
  const { client_id: clientId } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(oauthApp.url + '/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'browser-oauth-state'
  });
  await p.goto(authorize.href);
  const submit = async (password) => {
    await p.getByLabel('Admin Password').fill(password);
    const [response] = await Promise.all([
      p.waitForResponse((r) => r.url() === oauthApp.url + '/oauth/authorize' && r.request().method() === 'POST'),
      p.getByRole('button', { name: 'Authorize', exact: true }).click()
    ]);
    return response;
  };
  const retry = await submit('wrong-password');
  assert.equal(retry.status(), 401, `OAuth browser form sent Origin: ${await retry.request().headerValue('origin')}`);
  await p.getByRole('alert').getByText('Invalid admin password.').waitFor();
  const [approved, redirected] = await Promise.all([
    submit(adminPassword),
    p.waitForResponse((r) => r.url().startsWith(callback + '?'))
  ]);
  assert.equal(approved.status(), 200);
  assert.equal(await approved.request().headerValue('origin'), oauthApp.url);
  assert.equal(redirected.status(), 200);
  assert.equal(await redirected.request().headerValue('referer'), null);
  const result = new URL(redirected.url());
  assert.equal(result.searchParams.get('state'), 'browser-oauth-state');
  const exchange = await fetch(oauthApp.url + '/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: result.searchParams.get('code'),
      client_id: clientId,
      redirect_uri: callback,
      code_verifier: verifier
    })
  });
  assert.equal(exchange.status, 200);

  assert.deepEqual(errors, []);
  console.log(
    'PASS Chromium browser: i18n (en/zh-CN), desktop/mobile layout, connection editor, config import, permissions, descriptions, search, playground, activity logs, live MCP and OAuth authorization.'
  );
} finally {
  await browser?.close();
  await c.close();
  await oauthApp?.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
