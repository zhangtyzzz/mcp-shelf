import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {launch} from '../src/main.mjs';
const exec=promisify(execFile),root=fs.mkdtempSync('/tmp/shelf-claude-test-'),cd=path.join(root,'claude');
fs.mkdirSync(cd);
const a=await launch({dir:path.join(root,'shelf'),port:0,demo:true});
const cmd=process.env.CLAUDE_BIN||'claude',env={...process.env,CLAUDE_CONFIG_DIR:cd,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
const go=async args=>(await exec(cmd,args,{env,cwd:root,timeout:20_000})).stdout.trim();
const cli=fileURLToPath(new URL('../src/main.mjs',import.meta.url));
try{
 console.log(await go(['mcp','add','--transport','stdio','mcp-shelf','--env','MCP_SHELF_HOME='+a.config.dir,'--env','MCP_SHELF_PORT='+a.server.address().port,'--',process.execPath,cli,'stdio']));
 const r=await go(['mcp','list']);console.log(r);
 if(!/mcp-shelf.+(Connected|✓)/i.test(r))throw new Error('Claude did not report connected.');
}finally{await a.close();fs.rmSync(root,{recursive:true,force:true});}
