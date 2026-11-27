import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
 CallToolResultSchema,
 CancelTaskResultSchema,
 CreateTaskResultSchema,
 GetTaskResultSchema,
 ListTasksResultSchema,
 ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import {launch,createMcp,httpClient,demoSource} from '../src/main.mjs';
import {defaults,openConfig} from '../src/config.mjs';
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
 assert.equal(c.getServerCapabilities().tools.listChanged,true);
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
 assert.equal(found.matches[0].description,'自定义回声');
 assert.deepEqual(found.matches[0].inputSchema.required,['text']);
 const compact=await data(c,'search_tool',{query:'回声',include_schema:false});
 assert.equal(compact.matches[0].inputSchema,undefined);
 const exact=(await data(c,'search_tool',{tool_id:'demo/echo'})).matches[0];
 assert.deepEqual(exact.inputSchema.required,['text']);assert.deepEqual(exact.outputSchema.required,['echo']);
 assert.match((await call(c,'call_tool',{tool_id:'demo/echo',arguments:{text:5}})).content[0].text,/Arguments do not match/);
 assert.deepEqual(await data(c,'call_tool',{tool_id:'demo/echo',arguments:{text:'你好 MCP'}}),{echo:'你好 MCP'});
 assert.equal((await call(c,'call_tool',{tool_id:'demo/add',arguments:{a:1,b:2}})).isError,true);
 await f.api('descriptions','PUT',{search_tool:'Fresh discovery description'});
 await f.api('servers/demo','PUT',{...s,allowlist:['echo'],overrides:{echo:'Fresh echo description'}});
 const reconnected=await f.bridge();
 for(const client of [c,reconnected]){
  const tools=(await client.listTools()).tools;
  assert.match(tools.find(t=>t.name==='search_tool').description,/^Fresh discovery description/);
  const result=await data(client,'search_tool',{tool_id:'demo/echo'});
  assert.equal(result.matches[0].description,'Fresh echo description');
 }
 await f.api('servers','POST',{...s,id:'other',allowlist:['echo']},201);
 const page=await data(c,'search_tool',{query:'echo',limit:1});assert.equal(page.total,2);assert.equal(page.next_offset,1);
 assert.notEqual(page.matches[0].tool_id,(await data(c,'search_tool',{query:'echo',limit:1,offset:1})).matches[0].tool_id);
 assert.equal((await data(c,'search_tool',{server_id:'other',tool_id:'demo/echo'})).total,0);
 assert.equal((await f.api('servers/demo','PUT',{...s,allowlist:['echo'],args:[...s.args,'change']})).permissions_reset,true);
 assert.equal((await call(c,'call_tool',{tool_id:'demo/echo',arguments:{text:'no'}})).isError,true);
 await f.api('servers/other','PUT',{...s,id:'other',enabled:false,allowlist:['echo']});
 assert.equal((await call(c,'call_tool',{tool_id:'other/echo',arguments:{text:'no'}})).isError,true);
});

test('Streamable HTTP sends authenticated tool-list notifications only to affected profiles', {timeout: 5_000}, async t => {
 const f = await fixture(t);
 const demo = demoSource(['echo', 'missing']);
 const other = {...demoSource(['echo']), id: 'other'};
 await f.api('servers', 'POST', demo, 201);
 await f.api('servers', 'POST', other, 201);
 const selected = await f.api('profiles', 'POST', {id: 'only-demo', scope: 'selected', servers: ['demo']}, 201);
 const path = '/mcp/only-demo';
 const headers = {Accept: 'text/event-stream', Authorization: 'Bearer ' + selected.token};
 assert.equal((await fetch(f.app.url + path, {headers: {Accept: headers.Accept}})).status, 401);
 assert.equal((await fetch(f.app.url + '/mcp/other', {headers})).status, 401);
 assert.equal((await fetch(f.app.url + path, {headers: {...headers, Origin: 'https://foreign.example'}})).status, 403);
 assert.equal((await fetch(f.app.url + path, {headers: {...headers, 'MCP-Protocol-Version': '2000-01-01'}})).status, 400);

 async function subscribe(endpoint, secret) {
  const client = new Client({name: 'change-listener', version: '1'});
  t.after(() => client.close());
  const ready = Promise.withResolvers();
  const notices = [];
  let next = Promise.withResolvers();
  client.setNotificationHandler(ToolListChangedNotificationSchema, (message) => {
   notices.push(message.method);
   const delivered = next;
   next = Promise.withResolvers();
   delivered.resolve();
  });
  const transport = httpClient(f.app.url + endpoint, {Authorization: 'Bearer ' + secret}, undefined, async (url, options) => {
   const response = await fetch(url, options);
   if (options.method === 'GET') ready.resolve(response);
   return response;
  });
  await client.connect(transport);
  const stream = await ready.promise;
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(stream.headers.get('x-accel-buffering'), 'no');
  assert.equal(stream.headers.has('mcp-session-id'), false);
  return {client, notices, next: () => next.promise};
 }

 const master = await subscribe('/mcp', f.app.config.get().token);
 const scoped = await subscribe(path, selected.token);
 const beforeDiscovery = await scoped.client.listTools();
 const upstreamTools = await data(scoped.client, 'list_mcps');
 assert.deepEqual(upstreamTools.servers[0].tools, ['demo/echo']);
 assert.equal(upstreamTools.servers[0].tool_count, 1);
 assert.match(beforeDiscovery.tools[0].description, /- demo \(2 tools\)/);
 assert.deepEqual(await scoped.client.listTools(), beforeDiscovery);
 const masterChanged = master.next();
 await f.api('servers/other', 'PUT', {...other, description: 'Hidden connection changed'});
 await masterChanged;
 assert.match((await master.client.listTools()).tools[0].description, /Hidden connection changed/);

 const changed = scoped.next();
 await f.api('descriptions', 'PUT', {search_tool: 'Updated live search'});
 await changed;
 assert.deepEqual(scoped.notices, ['notifications/tools/list_changed']);
 assert.match((await scoped.client.listTools()).tools[1].description, /^Updated live search/);
 assert.doesNotMatch((await scoped.client.listTools()).tools[0].description, /Hidden connection changed/);

 const newApproval = scoped.next();
 await f.api('servers/demo', 'PUT', {...demo, allowlist: ['add', 'missing']});
 await newApproval;
 assert.deepEqual((await data(scoped.client, 'list_mcps')).servers[0].tools, ['demo/add']);

 const restricted = scoped.next();
 await f.api('profiles/only-demo', 'PUT', {scope: 'selected', servers: []});
 await restricted;
 assert.doesNotMatch((await scoped.client.listTools()).tools[0].description, /- demo \(/);

 const oldStream = await fetch(f.app.url + path, {headers, signal: AbortSignal.timeout(5_000)});
 assert.equal(oldStream.status, 200);
 await f.api('profiles/only-demo/rotate', 'POST');
 assert.equal(await oldStream.text(), ': connected\n\n');
 assert.equal((await fetch(f.app.url + path, {headers})).status, 401);
});

test('profile scopes migrate with existing tokens and empty selections stay closed', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-profile-migration-'));
 t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
 const configPath = path.join(dir, 'config.json');
 const legacy = {
  version: 1,
  token: 'a'.repeat(64),
  descriptions: defaults,
  profiles: [
   {id: 'legacy-all', token: 'b'.repeat(64), servers: []},
   {id: 'legacy-one', token: 'c'.repeat(64), servers: ['demo']}
  ],
  servers: [demoSource(['echo']), {...demoSource(['echo']), id: 'other'}]
 };
 const original = JSON.stringify(legacy);
 fs.writeFileSync(configPath, original, {mode: 0o600});
 const app = await launch({dir, port: 0});
 t.after(() => app.close());
 const backup = path.join(dir, 'config.v1.json');
 assert.equal(fs.readFileSync(backup, 'utf8'), original);
 if (process.platform !== 'win32') assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
 assert.equal(app.config.get().version, 2);
 assert.equal(app.config.get().token, legacy.token);
 assert.deepEqual(app.config.get().profiles.map(p => [p.scope, p.token]), [
  ['all', legacy.profiles[0].token], ['selected', legacy.profiles[1].token]
 ]);
 async function connect(profile) {
  const client = new Client({name: 'profile-regression', version: '1'});
  t.after(() => client.close());
  await client.connect(httpClient(app.url + '/mcp/' + profile.id, {Authorization: 'Bearer ' + profile.token}));
  return client;
 }
 const all = await connect(legacy.profiles[0]);
 assert.deepEqual((await data(all, 'list_mcps')).servers.map(s => s.id), ['demo', 'other']);
 const one = await connect(legacy.profiles[1]);
 assert.deepEqual((await data(one, 'list_mcps')).servers.map(s => s.id), ['demo']);
 const csrf = (await (await fetch(app.url + '/api/state')).json()).csrf;
 const edit = async payload => assert.equal((await fetch(app.url + '/api/profiles/legacy-one', {
  method: 'PUT',
  headers: {'Content-Type': 'application/json', 'X-Shelf-CSRF': csrf},
  body: JSON.stringify(payload)
 })).status, 200);
 await edit({servers: []});
 await edit({label: 'Disabled access'});
 assert.equal((await data(one, 'list_mcps')).total, 0);
 assert.equal((await data(one, 'search_tool', {tool_id: 'demo/echo'})).total, 0);
 assert.equal((await call(one, 'call_tool', {tool_id: 'demo/echo', arguments: {text: 'blocked'}})).isError, true);
 assert.doesNotMatch((await one.listTools()).tools[1].description, /- demo \(/);
 const reconnected = await connect(legacy.profiles[1]);
 assert.doesNotMatch(reconnected.getInstructions() || '', /- demo \(/);
 const reopened = openConfig(dir);
 assert.deepEqual(reopened.get().profiles[1].servers, []);
 assert.equal(reopened.get().profiles[1].scope, 'selected');
 assert.equal(fs.readFileSync(backup, 'utf8'), original);
});

test('real stdio subprocess bridge and restart persistence', {timeout: 10_000}, async t=>{
 const f=await fixture(t);
 await f.api('servers','POST',demoSource(['add']),201);
 const eventsOpened=Promise.withResolvers();
 const onEventStream=(req)=>{
  if(req.method==='GET'&&req.url==='/mcp'){
   f.app.server.off('request',onEventStream);
   eventsOpened.resolve();
  }
 };
 f.app.server.on('request',onEventStream);
 let c=await f.bridge(true);
 assert.equal(c.getServerCapabilities().tools.listChanged,true);
 await eventsOpened.promise;
 const notice=Promise.withResolvers();
 c.setNotificationHandler(ToolListChangedNotificationSchema,()=>notice.resolve());
 await f.api('descriptions','PUT',{search_tool:'自定义搜索'});
 await notice.promise;
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
 assert.equal((await fetch(u+'/mcp',{headers:{Authorization:'Bearer '+f.app.config.get().token}})).status,406);
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
  'model = "example"',
  '[mcp_servers."example.local"]',
  'command = "npx"',
  'args = [',
  '  "-y", # trailing comment',
  "  'prefix # literal',",
  '  "@example/mcp",',
  ']',
  'enabled = false',
  '[mcp_servers."example.local".env]',
  'EXAMPLE_API_KEY = "fixture-secret # not a comment"',
  '[mcp_servers.codex_remote]',
  'url = "https://example.com/mcp"',
  'bearer_token_env_var = "REMOTE_API_KEY"',
  'enabled = false',
  ''
 ].join('\n');
 const impToml = await f.api('import', 'POST', { text: tomlText }, 201);
 assert.deepEqual(impToml.imported, ['example-local', 'codex_remote']);
 const local = f.app.config.get().servers.find(s => s.id === 'example-local');
 assert.deepEqual(local.args, ['-y', 'prefix # literal', '@example/mcp']);
 assert.deepEqual(local.envKeys, ['EXAMPLE_API_KEY']);
 assert.equal(fs.readFileSync(f.app.config.file, 'utf8').includes('fixture-secret'), false);

 const antigravity = JSON.stringify({mcpServers: {
  'agy-remote': {serverUrl: 'https://example.com/mcp', headers: {Authorization: 'Bearer fixture-secret'}, enabled: false},
  'broken-args': {command: 'npx', args: ['valid', 42]},
  'broken-cwd': {command: 'npx', cwd: 42},
  'broken-url': {serverUrl: 42}
 }});
 const agyPreview = await f.api('import/preview', 'POST', {text: antigravity});
 assert.equal(agyPreview.items[0].server.url, 'https://example.com/mcp');
 assert.equal(agyPreview.items[0].warnings.length, 1);
 assert.equal(JSON.stringify(agyPreview).includes('fixture-secret'), false);
 assert.deepEqual(agyPreview.skipped.map(({id}) => id), ['broken-args', 'broken-cwd', 'broken-url']);
 const agyImport = await f.api('import', 'POST', {text: antigravity}, 201);
 assert.deepEqual(agyImport.imported, ['agy-remote']);
 const malformed = '[mcp_servers.invalid]\ncommand = "npx"\nargs = ["fixture-secret"';
 const parseError = await f.api('import', 'POST', {text: malformed}, 400);
 assert.match(parseError.error, /TOML/);
 assert.equal(parseError.error.includes('fixture-secret'), false);
 assert.equal(f.app.config.get().servers.some(s => s.id === 'invalid'), false);

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
 assert.match(failRefresh.error, /executable not found/i);

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

test('context budgets (serverReminder & search schema cap), configurable log retention/redaction, and idle settings', async t => {
 const f = await fixture(t);

 // 1. Add 15 servers with long descriptions and verify serverReminder stays strictly within budget
 for (let i = 0; i < 15; i++) {
  await f.api('servers', 'POST', {
   id: `srv-${i}`,
   label: `Service ${i}`,
   description: `Long description for upstream service number ${i} `.repeat(3),
   transport: 'http',
   url: `https://example-${i}.com/mcp`,
   enabled: true,
   allowlist: ['tool_a', 'tool_b']
  }, 201);
 }
 const c = await f.bridge();
 const listed = await c.listTools();
 // Meta-tool descriptions stay compact even with 15 servers
 assert.ok(listed.tools[1].description.length < 1100);
 assert.match(listed.tools[1].description, /\+\d+ more/);

 // 2. Configurable logLimit, logDetails redaction, and idleMinutes persistence
 await f.api('servers', 'POST', demoSource(['echo']), 201);
 await f.api('settings', 'PUT', { logLimit: 2, logDetails: true, idleMinutes: 5 });
 const stAfter = await f.get();
 assert.deepEqual(stAfter.settings, { logLimit: 2, logDetails: true, idleMinutes: 5, strictSchemaDrift: true });

 await call(c, 'call_tool', {
  tool_id: 'demo/echo',
  arguments: { text: 'hello' }
 });
 // Trigger an invalid call containing a sensitive key to verify redaction
 await call(c, 'call_tool', {
  tool_id: 'demo/echo',
  arguments: { text: 'x', apiKey: 'sk-live-secret-999' }
 });
 await data(c, 'list_mcps');

 const logRes = await (await fetch(f.app.url + '/api/logs')).json();
 // Enforces logLimit = 2
 assert.equal(logRes.logs.length, 2);
 const invalidLog = logRes.logs.find(l => l.status === 'invalid');
 assert.ok(invalidLog?.argsPreview);
 assert.equal(invalidLog.argsPreview.includes('sk-live-secret-999'), false);
 assert.match(invalidLog.argsPreview, /\[REDACTED\]/);

 // Disabling logs (logLimit = 0) clears and stops recording
 await f.api('settings', 'PUT', { logLimit: 0 });
 await data(c, 'list_mcps');
 const emptyLogs = await (await fetch(f.app.url + '/api/logs')).json();
 assert.equal(emptyLogs.logs.length, 0);

 // 3. Large upstream schemas obey the 16 KB search_tool response budget
 const bigSchema = {
  type: 'object',
  properties: Object.fromEntries(
   Array.from({ length: 120 }, (_, i) => [`field_${i}`, { type: 'string', description: 'D'.repeat(80) }])
  ),
  required: ['field_0']
 };
 const bigUpstream = http.createServer(async (req, res) => {
  const s = createMcp(
   () => ({
    tools: [
     { name: 'big_one', description: 'alpha large schema tool', inputSchema: bigSchema },
     { name: 'big_two', description: 'alpha second large schema tool', inputSchema: bigSchema }
    ]
   }),
   () => ({ content: [{ type: 'text', text: 'ok' }] })
  );
  const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await s.connect(tr);
  res.once('close', () => void s.close());
  await tr.handleRequest(req, res);
 });
 await new Promise(r => bigUpstream.listen(0, '127.0.0.1', r));
 t.after(() => { bigUpstream.closeAllConnections(); bigUpstream.close(); });
 await f.api('servers', 'POST', {
  id: 'big',
  transport: 'http',
  url: 'http://127.0.0.1:' + bigUpstream.address().port + '/mcp',
  enabled: true,
  allowlist: ['big_one', 'big_two']
 }, 201);
 const budgeted = await data(c, 'search_tool', { server_id: 'big', query: 'alpha' });
 assert.equal(budgeted.matches.length, 2);
 assert.ok(budgeted.matches[0].inputSchema, 'first match keeps full schema');
 assert.equal(budgeted.matches[1].schema_omitted, true, 'second match degrades when exceeding 16 KB budget');
 assert.deepEqual(budgeted.matches[1].required_params, ['field_0']);
 assert.match(budgeted.schema_budget_note || '', /16 KB/);
});

test('v0.7.0: access profiles, schema drift lock, MCP 2025-11-25 async tasks, icons metadata, templates, and OAuth 2.1 flow', async t => {
 const f = await fixture(t);

 // 1. Built-in templates include free Exa Search
 const initState = await f.get();
 assert.ok(initState.templates.some(tpl => tpl.id === 'exa' && tpl.url === 'https://mcp.exa.ai/mcp'));

 // 2. Mutable upstream for testing schema drift, icons metadata, and async tasks
 let schemaVersion = 1;
 const dynUpstream = http.createServer(async (req, res) => {
  const s = createMcp(
   () => ({
    tools: [
     {
      name: 'ping',
      title: 'Ping Tool',
      description: 'Ping with optional delay',
      icons: [
       { src: 'https://example.com/icon.png', mimeType: 'image/png' },
       { src: 'javascript:alert(1)' }
      ],
      inputSchema:
       schemaVersion === 1
        ? { type: 'object', properties: { msg: { type: 'string' }, delayMs: { type: 'number' } }, required: ['msg'], additionalProperties: false }
        : { type: 'object', properties: { msg: { type: 'string' }, extra: { type: 'boolean' } }, required: ['msg', 'extra'], additionalProperties: false }
     }
    ]
   }),
   async ({ arguments: a }) => {
    if (a?.delayMs) await new Promise(r => setTimeout(r, a.delayMs));
    return { content: [{ type: 'text', text: 'pong:' + a.msg }], structuredContent: { pong: a.msg } };
   }
  );
  const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await s.connect(tr);
  res.once('close', () => void s.close());
  await tr.handleRequest(req, res);
 });
 await new Promise(r => dynUpstream.listen(0, '127.0.0.1', r));
 t.after(() => { dynUpstream.closeAllConnections(); dynUpstream.close(); });

 await f.api('servers', 'POST', demoSource(['echo']), 201);
 await f.api('servers', 'POST', {
  id: 'dyn',
  label: 'Dynamic Server',
  transport: 'http',
  url: 'http://127.0.0.1:' + dynUpstream.address().port + '/mcp',
  enabled: true
 }, 201);
 await f.api('servers/dyn/refresh', 'POST');

 // Verify icons metadata sanitized (https kept, javascript stripped) and approve ping (auto-locks hash)
 const stBefore = await f.get();
 const dynSnap = stBefore.servers.find(s => s.id === 'dyn');
 assert.equal(dynSnap.tools[0].title, 'Ping Tool');
 assert.equal(dynSnap.tools[0].icons.length, 1);
 assert.equal(dynSnap.tools[0].icons[0].src, 'https://example.com/icon.png');
 const { tools: _t, status: _s, error: _e, missingEnvKeys: _m, oauthStatus: _o, ...dynClean } = dynSnap;
 await f.api('servers/dyn', 'PUT', { ...dynClean, allowlist: ['ping'] });

 // 3. Multi-profile isolation: vps-a sees only demo, vps-b sees only dyn
 const profA = await f.api('profiles', 'POST', { id: 'vps-a', label: 'VPS A', servers: ['demo'] }, 201);
 const profB = await f.api('profiles', 'POST', { id: 'vps-b', label: 'VPS B', servers: ['dyn'] }, 201);

 const cA = new Client({ name: 'client-a', version: '1' });
 t.after(() => cA.close());
 await cA.connect(httpClient(f.app.url + '/mcp/vps-a', { Authorization: 'Bearer ' + profA.token }));
 assert.match(cA.getInstructions() || '', /- demo \(/);
 assert.equal((cA.getInstructions() || '').includes('- dyn ('), false);
 assert.deepEqual((await data(cA, 'list_mcps')).servers.map(s => s.id), ['demo']);
 assert.equal((await call(cA, 'call_tool', { tool_id: 'dyn/ping', arguments: { msg: 'blocked' } })).isError, true);
 assert.deepEqual(await data(cA, 'call_tool', { tool_id: 'demo/echo', arguments: { text: 'ok-a' } }), { echo: 'ok-a' });

 // Wrong profile path with another profile's token is rejected
 assert.equal((await fetch(f.app.url + '/mcp/vps-a', { method: 'POST', headers: { Authorization: 'Bearer ' + profB.token } })).status, 401);

 // 4. MCP 2025-11-25 Async Tasks (create, get, list, result, cancel)
 const cB = new Client({ name: 'client-b', version: '1' });
 t.after(() => cB.close());
 await cB.connect(httpClient(f.app.url + '/mcp', { Authorization: 'Bearer ' + profB.token }));

 const created = await cB.request(
  {
   method: 'tools/call',
   params: { name: 'call_tool', arguments: { tool_id: 'dyn/ping', arguments: { msg: 'async', delayMs: 80 } }, task: { ttl: 60_000 } }
  },
  CreateTaskResultSchema
 );
 assert.ok(created.task.taskId.startsWith('task_'));
 const listedTasks = await cB.request({ method: 'tasks/list', params: {} }, ListTasksResultSchema);
 assert.ok(listedTasks.tasks.some(x => x.taskId === created.task.taskId));
 const taskResult = await cB.request(
  { method: 'tasks/result', params: { taskId: created.task.taskId } },
  CallToolResultSchema
 );
 assert.deepEqual(taskResult.structuredContent, { pong: 'async' });
 const taskStatus = await cB.request({ method: 'tasks/get', params: { taskId: created.task.taskId } }, GetTaskResultSchema);
 assert.equal(taskStatus.status, 'completed');

 const slowTask = await cB.request(
  {
   method: 'tools/call',
   params: { name: 'call_tool', arguments: { tool_id: 'dyn/ping', arguments: { msg: 'slow', delayMs: 5000 } }, task: { ttl: 60_000 } }
  },
  CreateTaskResultSchema
 );
 const cancelled = await cB.request({ method: 'tasks/cancel', params: { taskId: slowTask.task.taskId } }, CancelTaskResultSchema);
 assert.equal(cancelled.status, 'cancelled');

 // 5. Schema drift detection blocks tool until explicitly re-approved
 schemaVersion = 2;
 await f.api('servers/dyn/refresh', 'POST');
 const driftedState = await f.get();
 const driftedTool = driftedState.servers.find(s => s.id === 'dyn').tools[0];
 assert.equal(driftedTool.schemaDrifted, true);
 const driftBlocked = await call(cB, 'call_tool', { tool_id: 'dyn/ping', arguments: { msg: 'hi', extra: true } });
 assert.equal(driftBlocked.isError, true);
 assert.match(driftBlocked.content[0].text, /inputSchema changed/i);

 // Re-approve updates locked hash and restores access
 await f.api('servers/dyn', 'PUT', { ...dynClean, allowlist: ['ping'], reapproveTool: 'ping' });
 const afterReapprove = await data(cB, 'call_tool', { tool_id: 'dyn/ping', arguments: { msg: 'hi', extra: true } });
 assert.deepEqual(afterReapprove, { pong: 'hi' });

 // 6. End-to-end OAuth 2.1 + PKCE flow against a local mock OAuth + MCP server
 let issuedToken = 'oauth-access-token-12345';
 let refreshToken = 'mock-refresh-token';
 let refreshAttempts = 0;
 let refreshError;
 let rotateOnRefresh = false;
 const oauthServer = http.createServer(async (req, res) => {
  const base = 'http://127.0.0.1:' + oauthServer.address().port;
  const u = new URL(req.url, base);
  if (u.pathname === '/.well-known/oauth-authorization-server') {
   res.writeHead(200, { 'Content-Type': 'application/json' });
   return res.end(JSON.stringify({
    issuer: base,
    authorization_endpoint: base + '/authorize',
    token_endpoint: base + '/token',
    registration_endpoint: base + '/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256']
   }));
  }
  if (u.pathname === '/register' && req.method === 'POST') {
   let body = '';
   for await (const ch of req) body += ch;
   const meta = JSON.parse(body || '{}');
   res.writeHead(201, { 'Content-Type': 'application/json' });
   return res.end(JSON.stringify({ ...meta, client_id: 'mock-client-1' }));
  }
  if (u.pathname === '/token' && req.method === 'POST') {
   let body = '';
   for await (const chunk of req) body += chunk;
   const params = new URLSearchParams(body);
   if (params.get('grant_type') === 'refresh_token') {
    refreshAttempts++;
    const error = params.get('refresh_token') !== refreshToken ? 'invalid_grant' : refreshError;
    if (error) {
     res.writeHead(error === 'server_error' ? 503 : 400, { 'Content-Type': 'application/json' });
     return res.end(JSON.stringify({ error }));
    }
    if (rotateOnRefresh) {
     refreshToken = 'mock-rotated-refresh-token';
     await new Promise(resolve => setTimeout(resolve, 75));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ access_token: issuedToken, token_type: 'Bearer', expires_in: 3600,
     ...(rotateOnRefresh ? { refresh_token: refreshToken } : {}) }));
   }
   assert.equal(params.get('grant_type'), 'authorization_code');
   res.writeHead(200, { 'Content-Type': 'application/json' });
   return res.end(JSON.stringify({ access_token: issuedToken, refresh_token: 'mock-refresh-token', token_type: 'Bearer', expires_in: 3600 }));
  }
  if (u.pathname === '/mcp') {
   if (req.headers.authorization !== 'Bearer ' + issuedToken) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    return res.end();
   }
   const s = createMcp(() => ({ tools: [{ name: 'secret_read', inputSchema: { type: 'object' } }] }), () => ({ content: [{ type: 'text', text: 'ok' }] }));
   const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
   await s.connect(tr);
   res.once('close', () => void s.close());
   return await tr.handleRequest(req, res);
  }
  res.writeHead(404);
  res.end();
 });
 await new Promise(r => oauthServer.listen(0, '127.0.0.1', r));
 t.after(() => { oauthServer.closeAllConnections(); oauthServer.close(); });

 await f.api('servers', 'POST', {
  id: 'oauth-srv',
  label: 'OAuth MCP',
  transport: 'http',
  url: 'http://127.0.0.1:' + oauthServer.address().port + '/mcp',
  authMode: 'oauth',
  enabled: true
 }, 201);
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').oauthStatus, 'required');

 const started = await f.api('servers/oauth-srv/oauth/start', 'POST');
 assert.equal(started.status, 'redirect');
 assert.ok(started.authorizeUrl.includes('/authorize'));
 const authUrl = new URL(started.authorizeUrl);
 const cbRes = await fetch(f.app.url + '/api/oauth/callback?code=mock-code-1&state=' + encodeURIComponent(authUrl.searchParams.get('state')));
 assert.equal(cbRes.status, 200);
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').oauthStatus, 'connected');
 await f.api('servers/oauth-srv/refresh', 'POST');
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').tools[0].name, 'secret_read');

 // Existing deployments may have tokens without a separately saved callback or echoed DCR redirect URI.
 const oauthFile = path.join(f.app.config.dir, 'oauth', 'oauth-srv.json');
 const legacy = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
 delete legacy.redirectUrl;
 delete legacy.clientInformation.redirect_uris;
 fs.writeFileSync(oauthFile, JSON.stringify(legacy));
 issuedToken = 'oauth-access-token-renewed';
 await f.restart();
 await Promise.all([f.api('servers/oauth-srv/refresh', 'POST'), f.api('servers/oauth-srv/refresh', 'POST')]);
 assert.equal(refreshAttempts, 1);
 const renewed = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
 assert.equal(renewed.tokens.access_token, issuedToken);
 assert.equal(renewed.tokens.refresh_token, 'mock-refresh-token');
 assert.equal(renewed.codeVerifier, legacy.codeVerifier);
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').status, 'ready');

 // Two tool calls on a connected transport share a single-use refresh token exchange.
 issuedToken = 'oauth-access-token-rotated';
 rotateOnRefresh = true;
 const toolCall = { tool_id: 'oauth-srv/secret_read', arguments: {} };
 const calls = await Promise.all([f.app.catalog.testCall(toolCall), f.app.catalog.testCall(toolCall)]);
 assert.deepEqual(calls.map(result => result.content[0].text), ['ok', 'ok']);
 assert.equal(refreshAttempts, 2);
 const rotated = JSON.parse(fs.readFileSync(oauthFile, 'utf8'));
 assert.equal(rotated.tokens.refresh_token, refreshToken);

 // A transient upstream failure preserves the refresh token for retry.
 issuedToken = 'oauth-access-token-revoked';
 refreshError = 'server_error';
 const unavailable = await f.api('servers/oauth-srv/refresh', 'POST', undefined, 502);
 assert.match(unavailable.error, /OAuth token refresh failed/);
 assert.deepEqual(JSON.parse(fs.readFileSync(oauthFile, 'utf8')), rotated);

 // A revoked refresh token requires a fresh user sign-in.
 refreshError = 'invalid_grant';
 const failure = await f.api('servers/oauth-srv/refresh', 'POST', undefined, 502);
 assert.match(failure.error, /OAuth sign-in required/);
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').oauthStatus, 'required');
 assert.equal(refreshAttempts, 4);
 assert.equal((await f.api('servers/oauth-srv/oauth/start', 'POST')).status, 'redirect');

 await f.api('servers/oauth-srv/oauth/logout', 'POST');
 assert.equal((await f.get()).servers.find(s => s.id === 'oauth-srv').oauthStatus, 'required');
});
