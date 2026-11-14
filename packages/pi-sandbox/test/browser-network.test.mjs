import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {isLoopback,startBrowserProxy} from '../src/browser/network.mjs';
async function listen(server,host='127.0.0.1'){server.listen(0,host);await once(server,'listening');return server.address().port;}
function request(port,url){return new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:url},r=>{let body='';r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,body}));}).on('error',reject);});}
test('literal loopback matching excludes similar public names',()=>{for(const h of ['localhost','app.localhost','127.0.0.2','[::1]'])assert(isLoopback(h));for(const h of ['localhost.example','127.example','192.168.0.1'])assert(!isLoopback(h));});
test('local HTTP keeps exact loopback address, external traffic uses gateway, reserved ports apply locally',async()=>{
 const local=http.createServer((req,res)=>res.end(req.url));
 const upstream=http.createServer((req,res)=>res.end('gateway '+req.url));
 const port=await listen(local,'127.0.0.2'),up=await listen(upstream);
 const proxy=await startBrowserProxy({upstream:{host:'127.0.0.1',port:up}});
 try {
 assert.deepEqual(await request(proxy.port,`http://127.0.0.2:${port}/path?value=1`),{status:200,body:'/path?value=1'});
 assert.equal((await request(proxy.port,'http://public.example:19431/')).body,'gateway http://public.example:19431/');
 for(const port of [19431,3128,proxy.port])assert.equal((await request(proxy.port,`http://localhost:${port}/`)).status,403);
 proxy.reserve(port);assert.equal((await request(proxy.port,`http://127.0.0.2:${port}/`)).status,403);
 }finally{await proxy.close();local.closeAllConnections();upstream.closeAllConnections();local.close();upstream.close();}
});
test('CONNECT carries bidirectional bytes and closing proxy terminates active tunnels',async()=>{
 const echo=net.createServer(s=>s.pipe(s));const port=await listen(echo);
 const proxy=await startBrowserProxy({upstream:null});
 const client=net.connect(proxy.port,'127.0.0.1');
 try{
 await once(client,'connect');client.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`);
 const [ready]=await once(client,'data');assert.match(String(ready),/200 Connection Established/);
 client.write('tunnel works');const [body]=await once(client,'data');assert.equal(String(body),'tunnel works');
 const closed=once(client,'close');await proxy.close();await closed;
 }finally{client.destroy();echo.close();}
});

test('localhost reaches an IPv6-only development server',async t=>{
 const local=http.createServer((_req,res)=>res.end('IPv6 app'));
 let port;
 try{port=await listen(local,'::1');}catch(e){if(['EADDRNOTAVAIL','EAFNOSUPPORT'].includes(e.code)){t.skip('IPv6 unavailable');return;}throw e;}
 const proxy=await startBrowserProxy({upstream:null});
 try{for(const host of ['localhost','[::1]'])assert.deepEqual(await request(proxy.port,`http://${host}:${port}/`),{status:200,body:'IPv6 app'});}
 finally{await proxy.close();local.closeAllConnections();local.close();}
});

test('unrestricted routing keeps reserved listeners private through local address variants',async()=>{
 const proxy=await startBrowserProxy({upstream:null});
 try{for(const host of ['0.0.0.0','[::]','[::ffff:127.0.0.1]','localhost'])assert.equal((await request(proxy.port,`http://${host}:19431/`)).status,403);}
 finally{await proxy.close();}
});
