import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {SandboxBrowser} from '/opt/betterwright/browser.mjs';

const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><form><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>');
});
await new Promise(resolve => server.listen(18749, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:18749';
const password = 'SYNTHETIC_BROWSER_VAULT_PASSWORD';
const first = new SandboxBrowser();
const second = new SandboxBrowser();
try {
  assert.equal(first.vault.dir, join(homedir(), '.betterwright/vault'));
  const saved = await first.vault.handleRequest('save', {
    username:'fixture-user', password, label:'fixture', matchMode:'exact-origin',
  }, origin);
  assert(!JSON.stringify(saved).includes(password));
  const listed = await second.vault.handleRequest('list', {}, origin);
  assert(!JSON.stringify(listed).includes(password));
  assert(JSON.stringify(listed).includes('fixture-user'));
  const other = await second.vault.handleRequest('list', {}, 'http://127.0.0.1:18750');
  assert(!JSON.stringify(other).includes('fixture-user'));
  await assert.rejects(second.vault.handleRequest('ownerReveal', {}, origin));
  const start = await first.run(`await page.goto(${JSON.stringify(origin)}); return await credentials.list();`);
  assert.equal(start.ok, true, JSON.stringify(start));
  const accounts = start.result.credentials ?? start.result;
  assert.equal(accounts.length, 1, JSON.stringify(start));
  const filled = await first.fillCredential({id:accounts[0].id});
  assert(!JSON.stringify(filled).includes(password));
  const observed = await first.run("return {username:await page.locator('[name=username]').inputValue(),password:await page.locator('[name=password]').inputValue()};");
  assert.equal(observed.ok, true, JSON.stringify(observed));
  assert.equal(observed.result.username, 'fixture-user');
  assert(!JSON.stringify(observed).includes(password));
  assert(observed.result.password.length > 0, 'Password field was not filled');
  const vaultPath = first.vault.dir;
  await first.close();
  const retained = await second.vault.handleRequest('list', {}, origin);
  assert(JSON.stringify(retained).includes('fixture-user'));
  for (const filename of ['vault.enc','vault.key','audit.jsonl']) {
    const file = join(vaultPath,filename);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    if (filename !== 'vault.key') assert(!(await readFile(file)).includes(Buffer.from(password)));
  }
  console.log('PASS persistent vault, shared sessions, origin matching, encrypted records, private modes, trusted fill and password redaction');
} finally {
  await first.close();
  await second.close();
  await new Promise(resolve => server.close(resolve));
}
