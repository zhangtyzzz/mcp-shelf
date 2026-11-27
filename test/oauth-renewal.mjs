import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { httpClient, launch } from '../src/main.mjs';
import { OAuthStore } from '../src/oauth.mjs';

process.env.MCP_SHELF_OAUTH_ACCESS_TTL_SECONDS ??= '120';
const ttl = Number(process.env.MCP_SHELF_OAUTH_ACCESS_TTL_SECONDS);
assert.ok(ttl >= 1 && ttl <= 180, 'Use an isolated OAuth lifetime of 1 to 180 seconds for this test.');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-oauth-renewal-'));
const password = 'oauth-integration-test-password';
const app = await launch({ dir, port: 0, mode: 'remote', host: '127.0.0.1', demo: true, adminPassword: password });
const client = new Client({ name: 'shelf-oauth-renewal-test', version: '1' });
const resource = app.url + '/mcp';
const callback = app.url + '/test/callback';
const oauth = new OAuthStore(path.join(dir, 'client'), () => callback);
let authorizationUrl;
const provider = oauth.createProvider('shelf', callback, { onAuthorize: (url) => { authorizationUrl = url; } });

try {
  assert.equal(await auth(provider, { serverUrl: resource }), 'REDIRECT');
  const form = await (await fetch(authorizationUrl)).text();
  const nonce = /name="nonce"\s+value="([^"]+)"/.exec(form)?.[1];
  assert.ok(nonce);
  const consent = await fetch(app.url + '/oauth/authorize', {
    method: 'POST', redirect: 'manual', headers: { Origin: app.url },
    body: new URLSearchParams({ nonce, decision: 'approve', password })
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  assert.equal(await auth(provider, { serverUrl: resource, authorizationCode: code }), 'AUTHORIZED');
  const original = provider.tokens();
  const waitUntil = Date.now() + ttl * 1000 + 250;
  assert.equal(original.expires_in, ttl);
  assert.ok(original.refresh_token);

  await client.connect(httpClient(resource, {}, provider));
  const echo = async (text) => (await client.callTool({
    name: 'call_tool', arguments: { tool_id: 'demo/echo', arguments: { text } }
  })).structuredContent;
  assert.deepEqual(await echo('before expiry'), { echo: 'before expiry' });
  console.log(`OAuth client connected. Waiting for the real ${ttl}-second access token to expire.`);
  await delay(Math.max(0, waitUntil - Date.now()));

  const oldRequest = await fetch(resource, {
    method: 'POST', headers: { Authorization: 'Bearer ' + original.access_token }
  });
  assert.equal(oldRequest.status, 401);
  assert.match(oldRequest.headers.get('www-authenticate'), /error="invalid_token"/);
  assert.deepEqual(await echo('after automatic renewal'), { echo: 'after automatic renewal' });
  const renewed = provider.tokens();
  assert.notEqual(renewed.access_token, original.access_token);
  assert.notEqual(renewed.refresh_token, original.refresh_token);
  assert.equal(renewed.expires_in, ttl);
  console.log('PASS: the original token expired, the SDK rotated the refresh token, and the tool call succeeded automatically.');
} finally {
  await client.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
