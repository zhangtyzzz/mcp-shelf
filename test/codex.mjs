import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {launch} from '../src/main.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'shelf-codex-')),home=path.join(root,'codex');
fs.mkdirSync(home);
const runtime=path.join(root,"runtime");fs.mkdirSync(runtime,{mode:0o700});
const a=await launch({dir:path.join(root,'shelf'),port:0,demo:true});
const cli=fileURLToPath(new URL('../src/main.mjs',import.meta.url)),q=JSON.stringify;
fs.writeFileSync(path.join(home,'config.toml'),['[mcp_servers.mcp_shelf]','command = '+q(process.execPath),'args = '+q([cli,'stdio']),'startup_timeout_sec = 12','[mcp_servers.mcp_shelf.env]','MCP_SHELF_HOME = '+q(a.config.dir),'MCP_SHELF_PORT = '+q(String(a.server.address().port)),''].join('\n'));
const child=spawn(process.env.CODEX_BIN||'codex',['app-server','--listen','stdio://'],{cwd:root,env:{...process.env,CODEX_HOME:home,XDG_RUNTIME_DIR:runtime,TMPDIR:runtime},stdio:['pipe','pipe','pipe']});
let id=0,errors='';const pending=new Map();
child.stderr.on('data',b=>errors=(errors+b).slice(-1500));
child.on('error',err=>{for(const p of pending.values())p.reject(err);});
child.on('exit',code=>{for(const p of pending.values())p.reject(Error('Codex exited '+code+' '+errors));});
createInterface({input:child.stdout}).on('line',line=>{let r;try{r=JSON.parse(line);}catch{return;}const p=pending.get(r.id);if(p){if(r.error)p.reject(Error(JSON.stringify(r.error)));else p.resolve(r.result);}});
const send=x=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
function call(method,params){const thisId=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>end(reject,Error('Timed out '+method+' '+errors)),18_000);function end(fn,v){clearTimeout(timer);pending.delete(thisId);fn(v);}pending.set(thisId,{resolve:v=>end(resolve,v),reject:v=>end(reject,v)});send({id:thisId,method,params});});}
try{
 await call('initialize',{clientInfo:{name:'mcp_shelf_test',version:'0.1.0'},capabilities:{experimentalApi:true}});send({method:'initialized'});
 const statuses=await call('mcpServerStatus/list',{});
 const s=statuses.data?.find(r=>r.name==='mcp_shelf');if(!s)throw Error('Missing mcp_shelf '+JSON.stringify(statuses));
 assert.deepEqual(Object.keys(s.tools).sort(),['call_tool','list_mcps','search_tool']);
 console.log('PASS real Codex app-server MCP discovery: exact three tools.');
 if(process.argv.includes('--roundtrip')){
 const thread=await call('thread/start',{cwd:root,approvalPolicy:'never',sandbox:'read-only',ephemeral:true});
 const run=(tool,arguments_)=>call('mcpServer/tool/call',{threadId:thread.thread.id,server:'mcp_shelf',tool,arguments:arguments_});
 const x=await run('search_tool',{tool_id:'demo/echo'});assert.equal(x.structuredContent.matches[0].inputSchema.required[0],'text');
 const y=await run('call_tool',{tool_id:'demo/echo',arguments:{text:'Codex → Shelf → Demo'}});
 assert.deepEqual(y.structuredContent,{echo:'Codex → Shelf → Demo'});
 console.log('PASS real Codex app-server MCP round trip (no model inference).');
 }
}finally{child.kill();await a.close();fs.rmSync(root,{recursive:true,force:true});}
