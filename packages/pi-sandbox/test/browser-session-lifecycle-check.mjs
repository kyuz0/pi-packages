/** Execute only in an explicitly disposable Factory browser container. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readdir,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {SandboxBrowser} from '/opt/betterwright/browser.mjs';
const root='/home/node/.local/state/pi-browser-sessions';
const inventory=async()=>new Set(await readdir(root).catch(()=>[]));
const initial=await inventory();
const fixture=createServer((_req,res)=>{res.setHeader('Set-Cookie','sample_session=SYNTHETIC_LIFETIME_COOKIE; HttpOnly; Path=/');res.end('<title>Session lifetime fixture</title>Ready');});
await new Promise(resolve=>fixture.listen(18742,'127.0.0.1',resolve));
const target='http://127.0.0.1:18742/';
const NativeSocket=globalThis.WebSocket;
try {
 const unopened=new SandboxBrowser();
 await assert.rejects(unopened.exportSession(target),/No active browser session/);
 await unopened.close();
 assert.deepEqual(await inventory(),initial);
 for(const action of ['close','crash','abort']){
  const browser=new SandboxBrowser(),controller=new AbortController();
  const ready=await browser.run(`await page.goto(${JSON.stringify(target)});return true`);
  assert.equal(ready.ok,true);
  const id=(await browser.viewerLink()).split('/')[4];
  const rows=execFileSync('ps',['-eo','pid=,args='],{encoding:'utf8'}).split('\n');
  const child=Number(rows.find(line=>line.includes('--user-data-dir=/home/node/.cache/pi-browser/'+id)).trim().split(/\s+/)[0]);
  let interrupted=false,pendingClose;
  globalThis.WebSocket=class extends NativeSocket {
   target;
   send(text){const message=JSON.parse(text);if(message.method==='Network.getCookies')this.target=message.id;return super.send(text);}
   addEventListener(name,listener,options){
    if(name!=='message')return super.addEventListener(name,listener,options);
    return super.addEventListener(name,event=>{
     const response=JSON.parse(String(event.data));
     if(response.id===this.target&&!interrupted){interrupted=true;if(action==='close')pendingClose=browser.close();else if(action==='crash')process.kill(child,'SIGKILL');else controller.abort();}
     listener(event);
    },options);
   }
  };
  const before=await inventory();
  try {await assert.rejects(browser.exportSession(target,{signal:controller.signal}));assert(interrupted);}
  finally {globalThis.WebSocket=NativeSocket;await pendingClose;await browser.close();}
  assert.deepEqual(await inventory(),before,'An interrupted export left session files behind');
  console.log('PASS export interrupted by '+action+' leaves no session files');
 }
 const browser=new SandboxBrowser();
 try {
  assert.equal((await browser.run(`await page.goto(${JSON.stringify(target)});return true`)).ok,true);
  await assert.rejects(browser.exportSession('http://127.0.0.2:18742/'),/Open this service/);
  const result=await browser.exportSession(target);
  assert.equal(result.cookieCount,1);
  assert(!JSON.stringify(result).includes('SYNTHETIC_LIFETIME_COOKIE'));
  assert.equal((await browser.run('return await page.title()')).result,'Session lifetime fixture');
  assert((await browser.viewerLink()).includes('/v/'));
  await rm(result.path.slice(0,result.path.lastIndexOf('/')),{recursive:true,force:true});
 } finally {await browser.close();}
 console.log('PASS absent browser, absent origin, post-export browser/viewer continuity and private result');
} finally {
 globalThis.WebSocket=NativeSocket;
 await new Promise(resolve=>fixture.close(resolve));
 const after=await inventory();for(const name of after)if(!initial.has(name))await rm(root+'/'+name,{recursive:true,force:true});
}
