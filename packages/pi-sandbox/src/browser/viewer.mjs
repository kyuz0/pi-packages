/** Private container endpoint for the host's authenticated browser viewer. */
import { readFile, mkdir, writeFile, rename, readlink, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const browserRoot = '/home/node/.cache/pi-browser';
export const validId = id => /^[a-f0-9]{32}$/.test(id);
export function chromiumCommand(id) {
  const command = ['/opt/betterwright/.betterwright/chromium/linux-x64/betterchromium',
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + browserRoot + '/' + id];
  if (process.env.SANDBOX_NETWORK_MODE !== 'unrestricted')
    command.push('--proxy-server=http://127.0.0.1:3128', '--proxy-bypass-list=<-loopback>');
  return [...command, 'about:blank'];
}

export async function verifyBrowserSocket(id, socket, root = browserRoot) {
  // Bind this established connection to the immutable image binary and exact launch
  // arguments. A writable DevToolsActivePort file alone cannot identify its owner.
  const lock = await readlink(root + '/' + id + '/SingletonLock');
  const pid = /-(\d+)$/.exec(lock)?.[1];
  if (!pid) throw new Error('Browser process is unavailable');
  const processPath = '/proc/' + pid;
  const expected = chromiumCommand(id);
  if (await readlink(processPath + '/exe') !== expected[0] ||
      await readFile(processPath + '/cmdline', 'utf8') !== expected.join('\0') + '\0')
    throw new Error('Viewer endpoint is not the packaged browser');
  const address = port => '0100007F:' + port.toString(16).toUpperCase().padStart(4, '0');
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1);
    const row = rows.map(line => line.trim().split(/\s+/)).find(fields =>
      fields[1] === address(socket.remotePort) && fields[2] === address(socket.localPort) && fields[3] === '01');
    if (row && row[9] !== '0') {
      const descriptors = await readdir(processPath + '/fd');
      for (const fd of descriptors) {
        try {
          if (await readlink(processPath + '/fd/' + fd) === 'socket:[' + row[9] + ']') return;
        } catch { /* A browser file descriptor can close while being inspected. */ }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Viewer connection does not belong to this browser');
}
export async function bootStamp() {
  const stat = await readFile('/proc/1/stat', 'utf8');
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    + ':' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}
export async function viewerLink(id, root = browserRoot) {
  if (!validId(id)) throw new Error('Invalid browser session');
  let descriptor;
  try { descriptor = JSON.parse(await readFile(root + '/viewer.json', 'utf8')); }
  catch { throw new Error('Reopen this sandbox from the launcher to start its browser viewer.'); }
  if (descriptor.boot !== await bootStamp())
    throw new Error('Reopen this sandbox from the launcher to refresh its browser viewer.');
  const token = createHmac('sha256', descriptor.key).update(id).digest('hex');
  return descriptor.origin + '/v/' + id + '/' + token + '/';
}
export async function endpoint(id, root = browserRoot) {
  if (!validId(id)) throw new Error('Invalid browser session');
  const [port, path] = (await readFile(root + '/' + id + '/DevToolsActivePort', 'utf8')).trim().split('\n');
  if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535 ||
      !/^\/devtools\/browser\/[a-f0-9-]+$/.test(path)) throw new Error('Invalid browser endpoint');
  const origin = 'http://127.0.0.1:' + port;
  const response = await fetch(origin + '/json/version', { signal: AbortSignal.timeout(5000) });
  const version = await response.json();
  if (version.webSocketDebuggerUrl !== 'ws://127.0.0.1:' + port + path)
    throw new Error('Browser session has ended');
  return +port;
}
async function main() {
  if (process.argv[2] === 'set-descriptor' && process.argv.length === 3) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 2048) throw new Error('Descriptor too large');
    }
    const value = JSON.parse(input);
    if (!/^http:\/\/127(?:\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])){3}:[0-9]{1,5}$/.test(value.origin) || !/^[a-f0-9]{64}$/.test(value.key))
      throw new Error('Invalid viewer descriptor');
    await mkdir(browserRoot, { recursive: true, mode: 0o700 });
    const file = browserRoot + '/viewer.json';
    const temporary = file + '.' + process.pid;
    await writeFile(temporary, JSON.stringify({ ...value, boot: await bootStamp() }), { mode: 0o600 });
    await rename(temporary, file);
  } else if (process.argv[2] === 'connect' && process.argv.length === 4) {
    const port = await endpoint(process.argv[3]);
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => process.exit(1));
    await once(socket, 'connect');
    try { await verifyBrowserSocket(process.argv[3], socket); }
    catch (error) { socket.destroy(); throw error; }
    // EOF on stdin only closes the write half; Chromium can still send its response.
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on('end', () => process.stdin.destroy());
    process.stdout.on('error', () => socket.destroy());
  } else throw new Error('Invalid viewer command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
