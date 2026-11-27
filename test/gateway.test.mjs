import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {launch,createMcp,httpClient,demoSource} from '../src/main.mjs';
const cli=fileURLToPath(new URL('../src/main.mjs',import.meta.url));
const call=(c,name,arguments_={})=>c.callTool({name,arguments:arguments_});
const data=async(...args)=>(await call(...args)).structuredContent;
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shelf-test-'));
 let app=await launch({dir,port:0});
 const clients=[];
 async function stop(){for(const c of clients.splice(0))await c.close();await app.close();}
 t.after(async()=>{await stop();fs.rmSync(dir,{recursive:true,force:true});});
 const get=async()=>await (await fetch(app.url+'/api/state')).json();
 return {get,get app(){return app;},
  async bridge(stdio=false){
   const c=new Client({name:'sdk-fixture',version:'1'});clients.push(c);
   await c.connect(stdio?new StdioClientTransport({command:process.execPath,args:[cli,'stdio'],env:{MCP_SHELF_HOME:dir,MCP_SHELF_PORT:String(app.server.address().port)}}):httpClient(app.url+'/mcp',{Authorization:'Bearer '+app.config.get().token}),{timeout:5000});
   return c;
  },
  async api(where,method,body,expected=200){
   const r=await fetch(app.url+'/api/'+where,{method,headers:{'Content-Type':'application/json','X-Shelf-CSRF':(await get()).csrf},body:body&&JSON.stringify(body)});
   const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));return d;
  },
  async restart(){await stop();app=await launch({dir,port:0});}
 };
}
test('SDK via real HTTP gateway, discover exact schema and call namespaced stdio upstream', async t=>{
 const f=await fixture(t), c=await f.bridge();
 assert.deepEqual((await c.listTools()).tools.map(t=>t.name),['list_mcps','search_tool','call_tool']);
 assert.equal((await data(c,'list_mcps')).total,0);
 const s=demoSource([]);await f.api('servers','POST',s,201);await f.api('servers/demo/refresh','POST');
 assert.equal((await f.get()).servers[0].tools.length,2);
 assert.equal((await data(c,'search_tool')).total,0);
 assert.equal((await call(c,'call_tool',{tool_id:'demo/echo',arguments:{text:'no'}})).isError,true);
 await f.api('servers/demo','PUT',{...s,allowlist:['echo'],overrides:{echo:'自定义回声'}});
 const listed=await data(c,'list_mcps');assert.deepEqual(listed.servers[0].tools,['demo/echo']);
 // Dynamic server summary is injected into tools/list descriptions (Grok-Build style)
 const metaList=await c.listTools();
 assert.match(metaList.tools[1].description,/Connected MCP servers:\n- demo \(1 tool\):/);
 // search_tool returns full inputSchema by default (1-step discovery); include_schema=false returns compact view
 const found=await data(c,'search_tool',{query:'回声'});
 assert.equal(found.matches[0].tool_id,'demo/echo');
 assert.deepEqual(found.matches[0].inputSchema.required,['text']);
 const compact=await data(c,'search_tool',{query:'回声',include_schema:false});
 assert.equal(compact.matches[0].inputSchema,undefined);
 const exact=(await data(c,'search_tool',{tool_id:'demo/echo'})).matches[0];
 assert.deepEqual(exact.inputSchema.required,['text']);assert.deepEqual(exact.outputSchema.required,['echo']);
 assert.match((await call(c,'call_tool',{tool_id:'demo/echo',arguments:{text:5}})).content[0].text,/Arguments do not match/);
 assert.deepEqual(await data(c,'call_tool',{tool_id:'demo/echo',arguments:{text:'你好 MCP'}}),{echo:'你好 MCP'});
 assert.equal((await call(c,'call_tool',{tool_id:'demo/add',arguments:{a:1,b:2}})).isError,true);
 await f.api('servers','POST',{...s,id:'other',allowlist:['echo']},201);
 const page=await data(c,'search_tool',{query:'echo',limit:1});assert.equal(page.total,2);assert.equal(page.next_offset,1);
 assert.notEqual(page.matches[0].tool_id,(await data(c,'search_tool',{query:'echo',limit:1,offset:1})).matches[0].tool_id);
 assert.equal((await data(c,'search_tool',{server_id:'other',tool_id:'demo/echo'})).total,0);
 assert.equal((await f.api('servers/demo','PUT',{...s,allowlist:['echo'],args:[...s.args,'change']})).permissions_reset,true);
 assert.equal((await call(c,'call_tool',{tool_id:'demo/echo',arguments:{text:'no'}})).isError,true);
 await f.api('servers/other','PUT',{...s,id:'other',enabled:false,allowlist:['echo']});
 assert.equal((await call(c,'call_tool',{tool_id:'other/echo',arguments:{text:'no'}})).isError,true);
});
test('real stdio subprocess bridge and restart persistence', async t=>{
 const f=await fixture(t);
 await f.api('servers','POST',demoSource(['add']),201);
 let c=await f.bridge(true);
 await f.api('descriptions','PUT',{search_tool:'自定义搜索'});
 assert.ok((await c.listTools()).tools[1].description.startsWith('自定义搜索'));
 assert.match((await c.listTools()).tools[1].description,/Connected MCP servers:\n- demo \(1 tool\):/);
 assert.match(c.getInstructions()||'',/Connected MCP servers:\n- demo \(1 tool\):/);
 assert.deepEqual(await data(c,'call_tool',{tool_id:'demo/add',arguments:{a:20,b:22}}),{sum:42});
 if(process.platform!=='win32')assert.equal(fs.statSync(f.app.config.file).mode&0o777,0o600);
 const token=f.app.config.get().token;
 await f.restart();c=await f.bridge(true);
 assert.equal(f.app.config.get().token,token);
 assert.ok((await c.listTools()).tools[1].description.startsWith('自定义搜索'));
 assert.deepEqual(await data(c,'call_tool',{tool_id:'demo/add',arguments:{a:2,b:2}}),{sum:4});
});
test('Streamable HTTP upstream, pagination, separate bearer, exact result and no retry',async t=>{
 const f=await fixture(t), c=await f.bridge();const secret='test-upstream-token', env='SHELF_TEST_UPSTREAM_TOKEN';
 process.env[env]=secret;t.after(()=>delete process.env[env]);
 let pages=0,calls=0;
 const tool=n=>({name:n,inputSchema:{type:'object',additionalProperties:false}});
 const upstream=http.createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);return res.end();}
  if(req.method!=='POST'){res.writeHead(405);return res.end();}
  const s=createMcp(r=>{pages++;return r.params?.cursor?{tools:[tool('hidden')]}:{tools:[tool('sample'),tool('refuse')],nextCursor:'page2'};},({name})=>{
   calls++;
   return name==='sample'?{content:[{type:'text',text:'unchanged'},{type:'resource_link',name:'fixture',uri:'file:///fixture.txt'}],structuredContent:{count:7}}:{content:[{type:'text',text:'refused'}],isError:true};
  });
  const tr=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await s.connect(tr);res.once('close',()=>void s.close());await tr.handleRequest(req,res);
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
 await f.api('servers','POST',{id:'remote',enabled:true,transport:'http',url:'http://127.0.0.1:'+upstream.address().port+'/mcp',bearerEnv:env,allowlist:['sample','refuse']},201);
 assert.equal((await data(c,'search_tool',{server_id:'remote'})).total,2);assert.equal(pages,2);
 const good=await call(c,'call_tool',{tool_id:'remote/sample'});
 assert.equal(good.content[1].type,'resource_link');assert.deepEqual(good.structuredContent,{count:7});
 assert.equal((await call(c,'call_tool',{tool_id:'remote/refuse'})).isError,true);assert.equal(calls,2);
 assert.equal(JSON.stringify(await f.get()).includes(secret),false);
});
test('admin guards, separate client secret, and rejected unsafe URL settings',async t=>{
 const f=await fixture(t),u=f.app.url;
 assert.equal((await fetch(u+'/api/state',{headers:{Origin:'https://example.invalid'}})).status,403);
 assert.equal((await fetch(u+'/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await fetch(u+'/api/demo',{method:'POST'})).status,403);
 assert.equal((await fetch(u+'/mcp',{method:'POST'})).status,401);
 assert.equal((await fetch(u+'/mcp',{headers:{Authorization:'Bearer '+f.app.config.get().token}})).status,405);
 assert.equal(await new Promise((ok,no)=>http.get(u+'/api/state',{headers:{Host:'invalid.example'}},r=>{r.resume();ok(r.statusCode);}).on('error',no)),403);
 assert.equal(JSON.stringify(await f.get()).includes(f.app.config.get().token),false);
 await f.api('servers','POST',{id:'unsafe',transport:'http',url:'http://example.com/mcp',enabled:true},400);
 await f.api('servers','POST',{id:'unsafe',transport:'http',url:'https://user:secret@example.com/mcp',enabled:true},400);
 await f.api('demo','POST',undefined,201);assert.equal((await f.get()).servers[0].allowlist.length,0);
 await f.api('servers/demo','DELETE');assert.equal((await f.get()).servers.length,0);
});

test('config import (JSON and Codex TOML), refresh-all, tool playground, activity logs and diagnostics', async t => {
 const f = await fixture(t);
 assert.ok(f.app.server.requestTimeout >= 60_000, 'requestTimeout must exceed callTool 30s timeout');

 // 1. Import JSON (Claude/Antigravity format): extracts envKeys without saving secret values, skips mcp-shelf itself
 const jsonText = JSON.stringify({
  mcpServers: {
   'mcp-shelf': { command: process.execPath, args: [cli, 'stdio'] },
   'demo-imported': {
    command: process.execPath,
    args: [cli, 'demo-upstream'],
    env: { MY_SECRET_TOKEN: 'super-secret-value-never-stored' }
   }
  }
 });
 const preview = await f.api('import/preview', 'POST', { text: jsonText });
 assert.equal(preview.format, 'json');
 assert.equal(preview.items.length, 1);
 assert.equal(preview.items[0].server.id, 'demo-imported');
 assert.deepEqual(preview.items[0].server.envKeys, ['MY_SECRET_TOKEN']);
 assert.equal(preview.skipped.length, 1);

 const imported = await f.api('import', 'POST', { text: jsonText }, 201);
 assert.deepEqual(imported.imported, ['demo-imported']);
 const rawCfg = fs.readFileSync(f.app.config.file, 'utf8');
 assert.equal(rawCfg.includes('super-secret-value-never-stored'), false);

 // Missing env key warning is surfaced (only variable name)
 const st1 = await f.get();
 const impServer = st1.servers.find(s => s.id === 'demo-imported');
 assert.deepEqual(impServer.missingEnvKeys, ['MY_SECRET_TOKEN']);
 assert.deepEqual(impServer.allowlist, []);

 // 2. Import Codex TOML format
 const tomlText = [
  '[mcp_servers.codex_remote]',
  'url = "https://example.com/mcp"',
  'bearer_token_env_var = "REMOTE_API_KEY"',
  'enabled = false',
  ''
 ].join('\n');
 const impToml = await f.api('import', 'POST', { text: tomlText }, 201);
 assert.deepEqual(impToml.imported, ['codex_remote']);

 // 3. Refresh all enabled connections
 const refreshed = await f.api('servers/refresh-all', 'POST');
 assert.equal(refreshed.results.length, 1);
 assert.equal(refreshed.results[0].id, 'demo-imported');
 assert.equal(refreshed.results[0].status, 'ready');

 // 4. Playground test call works even before tool is added to Agent allowlist
 const testOk = await f.api('tools/test', 'POST', {
  tool_id: 'demo-imported/echo',
  arguments: { text: 'playground hello' }
 });
 assert.deepEqual(testOk.result.structuredContent, { echo: 'playground hello' });
 assert.equal(typeof testOk.durationMs, 'number');

 // Invalid args caught by JSON schema validation in playground too
 const testBad = await f.api('tools/test', 'POST', {
  tool_id: 'demo-imported/echo',
  arguments: { text: 123 }
 });
 assert.equal(testBad.result.isError, true);

 // 5. Activity logs record both playground and agent calls (including blocked)
 const c = await f.bridge();
 await data(c, 'list_mcps');
 await call(c, 'call_tool', { tool_id: 'demo-imported/echo', arguments: { text: 'blocked' } });
 const logRes = await (await fetch(f.app.url + '/api/logs')).json();
 assert.ok(logRes.logs.some(l => l.source === 'playground' && l.target === 'demo-imported/echo' && l.status === 'ok'));
 assert.ok(logRes.logs.some(l => l.source === 'agent' && l.action === 'list_mcps' && l.status === 'ok'));
 assert.ok(logRes.logs.some(l => l.source === 'agent' && l.target === 'demo-imported/echo' && l.status === 'blocked'));

 await f.api('logs', 'DELETE');
 const afterClear = await (await fetch(f.app.url + '/api/logs')).json();
 assert.equal(afterClear.logs.length, 0);

 // 6. Helpful error diagnosis when stdio command does not exist
 await f.api('servers', 'POST', {
  id: 'missing-bin',
  transport: 'stdio',
  command: '/nonexistent/mcp-shelf-missing-binary',
  args: [],
  enabled: true
 }, 201);
 const failRefresh = await f.api('servers/missing-bin/refresh', 'POST', undefined, 502);
 assert.match(failRefresh.error, /找不到可执行文件/);

 // 7. Health check, sanitized export, CJK bigram search recall, and schemaHash
 const health = await (await fetch(f.app.url + '/healthz')).json();
 assert.equal(health.ok, true);
 assert.equal(typeof health.uptimeSec, 'number');

 const exported = await (await fetch(f.app.url + '/api/export')).json();
 assert.equal(JSON.stringify(exported).includes(f.app.config.get().token), false);
 assert.ok(exported.mcpServers['demo-imported']);

 await f.api('servers/demo-imported', 'PUT', {
  ...st1.servers.find(s => s.id === 'demo-imported'),
  allowlist: ['echo']
 });
 // Query "回显文字" does not appear verbatim in "回显一段文字", but CJK bigram fallback finds it
 const cjkSearch = await data(c, 'search_tool', { query: '回显文字' });
 assert.equal(cjkSearch.matches[0]?.tool_id, 'demo-imported/echo');
 const detail = await data(c, 'search_tool', { tool_id: 'demo-imported/echo' });
 assert.match(detail.matches[0]?.schemaHash || '', /^[0-9a-f]{12}$/);

 // 8. SSE /mcp-events requires Bearer auth and pushes tools_changed on allowlist update
 assert.equal((await fetch(f.app.url + '/mcp-events')).status, 401);
 const gotEvent = await new Promise((resolve, reject) => {
  const req = http.get(f.app.url + '/mcp-events', {
   headers: { Authorization: 'Bearer ' + f.app.config.get().token }
  }, (res) => {
   let buf = '';
   res.setEncoding('utf8');
   res.on('data', (chunk) => {
    buf += chunk;
    if (/event:\s*ready/.test(buf) && !req._triggered) {
     req._triggered = true;
     void f.api('descriptions', 'PUT', { list_mcps: '触发事件更新' }).catch(reject);
    }
    if (/event:\s*tools_changed/.test(buf)) {
     req.destroy();
     resolve(true);
    }
   });
  });
  req.on('error', () => {});
  setTimeout(() => { req.destroy(); reject(new Error('Timed out waiting for tools_changed')); }, 4000);
 });
 assert.equal(gotEvent, true);
});

test('remote mode enforces admin password, HttpOnly signed session cookie, and MCP token rotation', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-remote-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

 // Reject remote mode without strong admin password
 await assert.rejects(
  () => launch({ dir, port: 0, mode: 'remote', host: '127.0.0.1', adminPassword: 'short' }),
  /MCP_SHELF_ADMIN_PASSWORD/
 );

 const app = await launch({
  dir,
  port: 0,
  mode: 'remote',
  host: '127.0.0.1',
  publicUrl: 'https://mcp.example.com',
  adminPassword: 'correct-horse-battery-staple'
 });
 t.after(() => app.close());

 // Unauthenticated requests to /api/state are blocked with 401
 const unauth = await fetch(app.url + '/api/state');
 assert.equal(unauth.status, 401);
 assert.equal((await unauth.json()).auth_required, true);

 const me0 = await (await fetch(app.url + '/api/auth/me')).json();
 assert.equal(me0.mode, 'remote');
 assert.equal(me0.authenticated, false);

 // Wrong password rejected
 const badLogin = await fetch(app.url + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'wrong-password-attempt' })
 });
 assert.equal(badLogin.status, 401);

 // Correct password issues HttpOnly SameSite=Strict Secure cookie
 const goodLogin = await fetch(app.url + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 'correct-horse-battery-staple' })
 });
 assert.equal(goodLogin.status, 200);
 const setCookie = goodLogin.headers.get('set-cookie') || '';
 assert.match(setCookie, /mcp_shelf_session=/);
 assert.match(setCookie, /HttpOnly/i);
 assert.match(setCookie, /SameSite=Strict/i);
 assert.match(setCookie, /Secure/i);
 const cookie = setCookie.split(';')[0];

 // Authenticated /api/state works and returns remoteEndpoint
 const stRes = await fetch(app.url + '/api/state', { headers: { Cookie: cookie } });
 assert.equal(stRes.status, 200);
 const st = await stRes.json();
 assert.equal(st.mode, 'remote');
 assert.equal(st.remoteEndpoint, 'https://mcp.example.com/mcp');
 assert.equal(JSON.stringify(st).includes(app.config.get().token), false);

 // Retrieve and rotate MCP Bearer token
 const tok1Res = await fetch(app.url + '/api/token', {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Shelf-CSRF': st.csrf }
 });
 assert.equal(tok1Res.status, 200);
 const oldTok = (await tok1Res.json()).token;
 assert.equal(oldTok, app.config.get().token);

 const rotRes = await fetch(app.url + '/api/token/rotate', {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Shelf-CSRF': st.csrf }
 });
 assert.equal(rotRes.status, 200);
 const newTok = (await rotRes.json()).token;
 assert.notEqual(newTok, oldTok);

 // Old token rejected on /mcp, new token accepted
 assert.equal((await fetch(app.url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + oldTok } })).status, 401);
 const c = new Client({ name: 'remote-client', version: '1' });
 t.after(() => c.close());
 await c.connect(httpClient(app.url + '/mcp', { Authorization: 'Bearer ' + newTok }));
 assert.equal((await c.listTools()).tools.length, 3);
});
