/** Trusted session handoff. Never expose CDP, cookie values or arbitrary paths to model code. */
import {mkdir, lstat, realpath, mkdtemp, open, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';

export function serviceURL(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('Use a valid service URL.'); }
  const loopback = url.hostname === '[::1]' || /^127(?:\.(?:\d{1,3})){3}$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash)
    throw Error('Use HTTPS (or loopback HTTP) without credentials, query parameters or fragments.');
  return url;
}

export function cookieHeader(cookies, value, now = Date.now() / 1000) {
  const url = serviceURL(value);
  if (!Array.isArray(cookies)) throw Error('Browser session data is unavailable.');
  const selected = cookies.filter(cookie => {
    if (!cookie || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || cookie.partitionKey) return false;
    const domain = cookie.domain.toLowerCase();
    const host = url.hostname.toLowerCase();
    const domainMatch = domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
    const pathMatch = url.pathname === cookie.path || (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
    return domainMatch && pathMatch && (!cookie.secure || url.protocol === 'https:') && (cookie.expires === -1 || cookie.expires === undefined || cookie.expires > now);
  }).sort((a,b) => b.path.length - a.path.length);
  if (!selected.length) throw Error('No matching session cookies. Complete the service login first.');
  if (selected.some(c => typeof c.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) || typeof c.value !== 'string' || /[\x00-\x20\x7f-\uffff;]/.test(c.value)))
    throw Error('The service session cannot be represented as a safe Cookie header.');
  const header = selected.map(c => c.name + '=' + c.value).join('; ');
  if (Buffer.byteLength(header) > 65536) throw Error('The service session is too large for this handoff.');
  return {header, count:selected.length};
}

export async function saveSessionFile(cookies, url, {root = join(homedir(), '.local/state/pi-browser-sessions'), active = () => true, signal} = {}) {
  const {header,count} = cookieHeader(cookies,url);
  const check = () => { if (signal?.aborted || !active()) throw Error('Session handoff cancelled because the browser or request changed.'); };
  check();
  await mkdir(root,{recursive:true,mode:0o700});
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await realpath(root) !== resolve(root))
    throw Error('Session storage must be a private owned directory without symlinks.');
  const directory = await mkdtemp(join(root,'session-'));
  const path = join(directory,'cookies.txt');
  try {
    check();
    const file = await open(path,'wx',0o600);
    try { await file.writeFile(header + '\n'); } finally { await file.close(); }
    check();
    return {url:serviceURL(url).href,path,cookieCount:count};
  } catch(error) {
    await rm(directory,{recursive:true,force:true});
    throw error;
  }
}

export async function collectSessionCookies(endpoint, value, {signal, WebSocketImpl = WebSocket} = {}) {
  const url = serviceURL(value);
  if (signal?.aborted) throw Error('Session handoff cancelled.');
  const socket = new WebSocketImpl(endpoint);
  let nextId = 0, attached;
  const pending = new Map();
  const fail = () => { for (const {reject} of pending.values()) reject(Error('Browser session connection ended.')); pending.clear(); };
  socket.addEventListener('message',event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { fail(); socket.close(); return; }
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(Error('Browser session request failed.'));
    else operation.resolve(message.result);
  });
  socket.addEventListener('close',fail);
  socket.addEventListener('error',fail);
  const cancel = () => { fail(); socket.close(); };
  const timeout = setTimeout(cancel,15000);
  signal?.addEventListener('abort',cancel,{once:true});
  const send = (method,params={},sessionId) => new Promise((resolve,reject) => {
    if (socket.readyState !== 1 || signal?.aborted) return reject(Error('Browser session is unavailable.'));
    const id = ++nextId;
    pending.set(id,{resolve,reject});
    socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
  try {
    await new Promise((resolve,reject) => {
      socket.addEventListener('open',resolve,{once:true});
      socket.addEventListener('error',()=>reject(Error('Browser session connection failed.')),{once:true});
      socket.addEventListener('close',()=>reject(Error('Browser session connection ended.')),{once:true});
    });
    const {targetInfos} = await send('Target.getTargets');
    const pages = targetInfos?.filter(target => {
      try { return target.type === 'page' && new URL(target.url).origin === url.origin; } catch { return false; }
    });
    if (!pages?.length) throw Error('Open this service in the current browser session before exporting its login.');
    if (new Set(pages.map(page => page.browserContextId ?? 'default')).size !== 1)
      throw Error('This service is open in multiple browser contexts; choose one login context first.');
    const {sessionId} = await send('Target.attachToTarget',{targetId:pages[0].targetId,flatten:true});
    attached = sessionId;
    const {cookies} = await send('Network.getCookies',{urls:[url.href]},sessionId);
    return cookies;
  } finally {
    if (attached && socket.readyState === 1 && !signal?.aborted) {
      try { await send('Target.detachFromTarget',{sessionId:attached}); } catch {}
    }
    clearTimeout(timeout);signal?.removeEventListener('abort',cancel);socket.close();fail();
  }
}
