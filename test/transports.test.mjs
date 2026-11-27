import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { launch, httpClient, demoSource } from '../src/main.mjs';

test('MCP Shelf built-in OAuth 2.1 + PKCE S256 server (discovery, DCR, password check, PKCE verify, scoped token)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-oauth-srv-'));
  const app = await launch({
    dir,
    port: 0,
    mode: 'remote',
    host: '127.0.0.1',
    adminPassword: 'super-strong-admin-pass-123'
  });
  t.after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1. Unauthenticated /mcp returns 401 with RFC 9728 resource_metadata pointer
  const unauth = await fetch(app.url + '/mcp', { method: 'POST' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') || '', /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);

  // 2. Discover Protected Resource Metadata & Authorization Server Metadata
  const prm = await (await fetch(app.url + '/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(prm.resource, app.url + '/mcp');
  assert.deepEqual(prm.authorization_servers, [app.url]);

  const asm = await (await fetch(app.url + '/.well-known/oauth-authorization-server')).json();
  assert.equal(asm.issuer, app.url);
  assert.equal(asm.authorization_endpoint, app.url + '/oauth/authorize');
  assert.equal(asm.token_endpoint, app.url + '/oauth/token');
  assert.equal(asm.registration_endpoint, app.url + '/oauth/register');
  assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);

  // 3. Dynamic Client Registration rejects unsafe redirect_uri and accepts loopback
  const badReg = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Bad', redirect_uris: ['javascript:alert(1)'] })
  });
  assert.equal(badReg.status, 400);

  const regRes = await fetch(asm.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test OAuth Agent', redirect_uris: ['http://127.0.0.1:19999/cb'] })
  });
  assert.equal(regRes.status, 201);
  const client = await regRes.json();
  assert.ok(client.client_id.startsWith('shelf_cli_'));

  // Configure two upstreams and a scoped profile via authenticated admin API
  const loginRes = await fetch(app.url + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'super-strong-admin-pass-123' })
  });
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
  const st = await (await fetch(app.url + '/api/state', { headers: { Cookie: cookie } })).json();
  const api = (p, m, b) =>
    fetch(app.url + '/api/' + p, {
      method: m,
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-Shelf-CSRF': st.csrf },
      body: JSON.stringify(b)
    });
  await api('servers', 'POST', demoSource(['echo']));
  await api('servers', 'POST', { ...demoSource(['add']), id: 'other', label: 'Other Demo' });
  await api('profiles', 'POST', { id: 'only-demo', label: 'Only Demo', servers: ['demo'] });

  // 4. GET /oauth/authorize renders form with nonce
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(asm.authorization_endpoint);
  authUrl.searchParams.set('client_id', client.client_id);
  authUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:19999/cb');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', 'xyz-state');

  const formHtml = await (await fetch(authUrl)).text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(formHtml)?.[1];
  assert.ok(nonce, 'authorize form includes CSRF nonce');

  // Wrong password rejected (401)
  const badApprove = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nonce, decision: 'approve', password: 'wrong-password', profile_id: 'only-demo' })
  });
  assert.equal(badApprove.status, 401);
  const retryNonce = /name="nonce"\s+value="([^"]+)"/.exec(await badApprove.text())?.[1];
  assert.ok(retryNonce);

  // Correct password issues 302 redirect with authorization code
  const okApprove = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      nonce: retryNonce,
      decision: 'approve',
      password: 'super-strong-admin-pass-123',
      profile_id: 'only-demo'
    })
  });
  assert.equal(okApprove.status, 302);
  const loc = new URL(okApprove.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz-state');
  const code = loc.searchParams.get('code');
  assert.ok(code.startsWith('code_'));

  // 5. Wrong PKCE verifier rejected (and code is single-use, so let's test good verifier directly first on a fresh code, or test bad verifier on a second code)
  const formHtml2 = await (await fetch(authUrl)).text();
  const nonce2 = /name="nonce"\s+value="([^"]+)"/.exec(formHtml2)?.[1];
  const okApprove2 = await fetch(asm.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      nonce: nonce2,
      decision: 'approve',
      password: 'super-strong-admin-pass-123',
      profile_id: 'only-demo'
    })
  });
  const badCode = new URL(okApprove2.headers.get('location')).searchParams.get('code');
  const badTok = await fetch(asm.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: badCode,
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:19999/cb',
      code_verifier: 'wrong-pkce-verifier'
    })
  });
  assert.equal(badTok.status, 400);

  // Good PKCE verifier exchanges for access_token bound to `only-demo` profile
  const tokRes = await fetch(asm.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:19999/cb',
      code_verifier: verifier
    })
  });
  assert.equal(tokRes.status, 200);
  const tokData = await tokRes.json();
  assert.equal(tokData.token_type, 'Bearer');
  assert.ok(tokData.access_token.length === 64);

  // 6. Connect MCP client with OAuth access_token — strictly scoped to `only-demo`
  const mcpClient = new Client({ name: 'oauth-mcp-client', version: '1' });
  t.after(() => mcpClient.close());
  await mcpClient.connect(httpClient(app.url + '/mcp', { Authorization: 'Bearer ' + tokData.access_token }));
  const listed = (await mcpClient.callTool({ name: 'list_mcps', arguments: {} })).structuredContent;
  assert.deepEqual(listed.servers.map((s) => s.id), ['demo']);
  const blockedOther = await mcpClient.callTool({
    name: 'call_tool',
    arguments: { tool_id: 'other/add', arguments: { a: 1, b: 2 } }
  });
  assert.equal(blockedOther.isError, true);
  const echoed = (
    await mcpClient.callTool({
      name: 'call_tool',
      arguments: { tool_id: 'demo/echo', arguments: { text: 'oauth-works' } }
    })
  ).structuredContent;
  assert.deepEqual(echoed, { echo: 'oauth-works' });
});
