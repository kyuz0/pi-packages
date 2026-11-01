import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const {createJiti}=createRequire(root+'/package.json')('jiti');
const jiti=createJiti(root+'/package.json',{tryNative:false});
const {default:approval}=await jiti.import(root+'/packages/pi-auto-review/src/container-approval-mode.ts');
const {BOUNDARY_BROKER_SERVICE_KEY:key}=await jiti.import(root+'/packages/pi-auto-review/src/broker/index.ts');
let passed=0;
for(const mode of ['manual','off']) {
 process.env.SANDBOX_APPROVAL_MODE=mode;
 const hooks=new Map();approval({on:(name,fn)=>hooks.set(name,fn)});
 const service=globalThis[key];
 assert.equal((await service.review()).kind,mode==='manual'?'defer':'deny');passed++;
 assert.equal(service.consumeGrant(),false);passed++;
 assert.throws(()=>approval({on(){}}),/Duplicate/);passed++;
 hooks.get('session_shutdown')();assert.equal(globalThis[key],undefined);passed++;
}
process.env.SANDBOX_APPROVAL_MODE='invalid';assert.throws(()=>approval({on(){}}),/Invalid/);passed++;
const {default:child}=await jiti.import(root+'/packages/pi-sandbox/src/container-child-policy.ts');
const hooks=new Map();child({on:(name,fn)=>hooks.set(name,fn)});
assert.deepEqual([...hooks.keys()],['session_start','before_agent_start','session_shutdown']);passed++;
console.log(`${passed} container-policy checks passed`);
