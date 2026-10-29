import { zipSync, strToU8 } from 'fflate';
const server = `const rl = require('node:readline').createInterface({input:process.stdin});
const tools=[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{}}}];
rl.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;
switch(r.method){case 'initialize':result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bundle-fixture',version:'1'}};break;
case 'tools/list':result={tools};break;case 'server/discover':result={tools,prompts:[],resources:[],resourceTemplates:[]};break;
case 'tools/call':result={content:[{type:'text',text:'fixture'}]};break;default:result={};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`;
export function manifest(command = process.execPath) {
  return {
    manifest_version: '0.3',
    name: 'bundle-fixture',
    version: '1.0.0',
    server: {
      type: 'node',
      entry_point: 'server.cjs',
      mcp_config: {
        command,
        args: ['${__dirname}/server.cjs'],
        env: { PRIVATE: '${user_config.key}' },
      },
    },
    user_config: { key: { type: 'string', required: true, sensitive: true } },
  };
}
export function archive(value = manifest()) {
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(value)),
    'server.cjs': strToU8(server),
  });
}
