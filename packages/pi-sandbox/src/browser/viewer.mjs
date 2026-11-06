/** Private container endpoint for the host's authenticated browser viewer. */
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const browserRoot = '/home/node/.cache/pi-browser';
export const validId = id => /^[a-f0-9]{32}$/.test(id);
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
    // EOF on stdin only closes the write half; Chromium can still send its response.
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on('end', () => process.stdin.destroy());
    process.stdout.on('error', () => socket.destroy());
  } else throw new Error('Invalid viewer command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
