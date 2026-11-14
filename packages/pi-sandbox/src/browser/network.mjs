/** Route browser dev-server traffic inside its container, keeping infrastructure private. */
import http from 'node:http';
import net from 'node:net';
import {lookup} from 'node:dns/promises';

export function isLoopback(host) {
  return host === '0.0.0.0' || host === '[::]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) || host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
    (net.isIP(host) === 4 && host.startsWith('127.'));
}

export async function startBrowserProxy({upstream = {host:'127.0.0.1',port:3128}} = {}) {
  const reserved = new Set([3128,19431]);
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close',()=>sockets.delete(socket)); return socket; };
  const target = async (value,connect=false) => {
    const url = new URL(connect ? 'https://' + value : value);
    if (url.username || url.password || !['http:','https:','ws:','wss:'].includes(url.protocol)) throw Error('Invalid URL');
    const port = Number(url.port || (['https:','wss:'].includes(url.protocol)?443:80));
    const local = isLoopback(url.hostname);
    if (local && reserved.has(port)) throw Error('Reserved infrastructure port');
    let host = url.hostname.replace(/^\[|\]$/g,'');
    if (local && !net.isIP(host)) host = 'localhost';
    if (!local && !upstream && reserved.has(port)) {
      // Resolve once and connect to that address: do not re-resolve after checking.
      const addresses = await lookup(host,{all:true});
      if (addresses.some(({address})=>isLoopback(net.isIP(address)===6?'['+address+']':address)))
        throw Error('Reserved infrastructure port');
      host = addresses[0].address;
    }
    return {url,port,local,host};
  };
  const refuse = (socket,status=403) => socket.end(`HTTP/1.1 ${status} Blocked\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const server = http.createServer(async (req,res)=>{
    let t;
    try {t=await target(req.url);} catch {res.writeHead(403);res.end('Browser infrastructure ports are private.');return;}
    const proxy = !t.local && upstream;
    const headers={...req.headers};delete headers['proxy-authorization'];delete headers['proxy-connection'];
    const outgoing=http.request({host:proxy?proxy.host:t.host,port:proxy?proxy.port:t.port,
      method:req.method,path:proxy?req.url:t.url.pathname+t.url.search,headers},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res);
    });
    outgoing.on('socket',track);
    outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>outgoing.destroy());res.on('close',()=>outgoing.destroy());
    outgoing.setTimeout(120000,()=>outgoing.destroy());req.pipe(outgoing);
  });
  async function tunnel(req,client,head,connect) {
    let t;
    try {t=await target(req.url,connect);} catch {refuse(client);return;}
    const proxy=!t.local && upstream;
    const remote=track(net.connect(proxy?proxy.port:t.port,proxy?proxy.host:t.host));
    remote.on('error',()=>client.destroy());client.on('error',()=>remote.destroy());
    client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());
    remote.once('connect',()=>{
      if(connect && !proxy) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else {
        const path=connect?req.url:proxy?req.url:t.url.pathname+t.url.search;
        const headers=Object.entries(req.headers).filter(([k])=>k!=='proxy-authorization'&&k!=='proxy-connection')
          .flatMap(([k,v])=>(Array.isArray(v)?v:[v]).map(value=>`${k}: ${value}`));
        remote.write(`${req.method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      }
      if(head.length)remote.write(head);
      remote.pipe(client);client.pipe(remote);
    });
  }
  server.on('connect',(req,socket,head)=>tunnel(req,socket,head,true));
  server.on('upgrade',(req,socket,head)=>tunnel(req,socket,head,false));
  server.on('connection',socket=>{track(socket);socket.on('error',()=>{});});
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;reserved.add(port);
  return {port,reserve(port){reserved.add(port);},async close(){
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
  }};
}
