import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readFile,mkdir,symlink,readdir,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cookieHeader,serviceURL,saveSessionFile,collectSessionCookies} from '../src/browser/session-export.mjs';

const origin='https://expenses.example.test/api/expenses';
const cookie=(overrides={})=>({name:'session',value:'SYNTHETIC_SESSION',domain:'expenses.example.test',path:'/',secure:true,expires:-1,...overrides});

test('service URL requires HTTPS or loopback and rejects URL credentials and tokens',()=>{
  for(const url of [origin,'http://127.0.0.1:18740/api','http://[::1]:18740/api']) assert.equal(serviceURL(url).href,url);
  for(const url of ['file:///tmp/a','http://expenses.example.test/','https://user:password@expenses.example.test/','https://expenses.example.test/?token=synthetic','https://expenses.example.test/#token','http://localhost:18740/api','http://localhost.evil.test/','invalid']) assert.throws(()=>serviceURL(url));
});

test('only matching cookies become a valid header, ordered by path specificity',()=>{
  const data=[cookie(),cookie({name:'specific',path:'/api'}),cookie({name:'parent',domain:'.example.test'}),cookie({domain:'mail.example.test'}),cookie({domain:'evil-expenses.example.test'}),cookie({domain:'.other.test'}),cookie({path:'/ap'}),cookie({path:'/api/other'}),cookie({expires:1}),cookie({partitionKey:{topLevelSite:'https://other.test'}})];
  assert.deepEqual(cookieHeader(data,origin,2),{header:'specific=SYNTHETIC_SESSION; session=SYNTHETIC_SESSION; parent=SYNTHETIC_SESSION',count:3});
  assert.throws(()=>cookieHeader([cookie()], 'http://127.0.0.1/api'),/No matching/);
  assert.throws(()=>cookieHeader([cookie({value:'synthetic\r\nInjected: value'})],origin),/safe Cookie/);
  assert.throws(()=>cookieHeader([cookie({name:'bad=name'})],origin),/safe Cookie/);
  assert.throws(()=>cookieHeader([cookie({value:'x'.repeat(65537)})],origin),/too large/);
});

test('handoff creates unique private files outside the workspace and returns no values',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'session-export-'));
  const root=join(temporary,'private');
  try {
    const first=await saveSessionFile([cookie()],origin,{root});
    const second=await saveSessionFile([cookie({value:'OTHER_SYNTHETIC_SESSION'})],origin,{root});
    assert.notEqual(first.path,second.path);
    assert.equal((await stat(root)).mode&0o777,0o700);
    assert.equal((await stat(first.path)).mode&0o777,0o600);
    assert.equal((await stat(first.path+'/..').catch(()=>stat(first.path.slice(0,first.path.lastIndexOf('/'))))).mode&0o777,0o700);
    assert.equal(await readFile(first.path,'utf8'),'session=SYNTHETIC_SESSION\n');
    assert(!JSON.stringify(first).includes('SYNTHETIC_SESSION'));
  } finally {await rm(temporary,{recursive:true,force:true});}
});

test('handoff rejects unsafe roots, symlinks, empty sessions and cancellation without leaving files',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'session-export-'));
  try {
    const unsafe=join(temporary,'unsafe'),alias=join(temporary,'alias'),real=join(temporary,'real');
    await mkdir(unsafe,{mode:0o755});await chmod(unsafe,0o755);
    await assert.rejects(saveSessionFile([cookie()],origin,{root:unsafe}),/private owned/);
    await mkdir(real,{mode:0o700});await symlink(real,alias);
    await assert.rejects(saveSessionFile([cookie()],origin,{root:alias}),/private owned/);
    await assert.rejects(saveSessionFile([],origin,{root:real}),/No matching/);
    await assert.rejects(saveSessionFile([cookie()],origin,{root:real,signal:AbortSignal.abort()}),/cancelled/);
    let checks=0;
    await assert.rejects(saveSessionFile([cookie()],origin,{root:real,active:()=>++checks<3}),/cancelled/);
    assert.deepEqual(await readdir(real),[]);
  } finally {await rm(temporary,{recursive:true,force:true});}
});

class Socket extends EventTarget {
  static sent=[]; static pages=[{type:'page',targetId:'current',url:origin}];
  readyState=0;
  constructor(){super();queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  send(text){const message=JSON.parse(text);Socket.sent.push(message);const result=message.method==='Target.getTargets'?{targetInfos:Socket.pages}:message.method==='Target.attachToTarget'?{sessionId:'attached'}:{cookies:[cookie()]};queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:message.id,result})})));}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
}

test('trusted CDP request is bound to an open exact-origin page and one URL',async()=>{
  Socket.sent=[];Socket.pages=[{type:'page',targetId:'current',url:origin}];
  const result=await collectSessionCookies('ws://127.0.0.1/private',origin,{WebSocketImpl:Socket});
  assert.deepEqual(result,[cookie()]);
  assert.deepEqual(Socket.sent.map(m=>m.method),['Target.getTargets','Target.attachToTarget','Network.getCookies','Target.detachFromTarget']);
  assert.deepEqual(Socket.sent[2].params,{urls:[origin]});
  assert.equal(Socket.sent[2].sessionId,'attached');
  Socket.sent=[];Socket.pages=[{type:'page',targetId:'other',url:'https://mail.example.test/'}];
  await assert.rejects(collectSessionCookies('ws://127.0.0.1/private',origin,{WebSocketImpl:Socket}),/Open this service/);
  assert.equal(Socket.sent.length,1);
  Socket.pages=[{type:'page',targetId:'one',url:origin,browserContextId:'one'},{type:'page',targetId:'two',url:origin,browserContextId:'two'}];
  await assert.rejects(collectSessionCookies('ws://127.0.0.1/private',origin,{WebSocketImpl:Socket}),/multiple browser contexts/);
  await assert.rejects(collectSessionCookies('ws://127.0.0.1/private',origin,{signal:AbortSignal.abort(),WebSocketImpl:Socket}),/cancelled/);
});
