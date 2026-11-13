import {createServer} from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { bootStamp, viewerLink, endpoint, desktopSocket } from '../src/browser/viewer.mjs';

test('viewer links are session-specific and reject stale container descriptors', async () => {
  const root = await mkdtemp(tmpdir() + '/pi-viewer-');
  const key = 'b'.repeat(64), id = 'a'.repeat(32);
  try {
    await assert.rejects(viewerLink(id, root), /Reopen this sandbox/);
    await writeFile(root + '/viewer.json', JSON.stringify({origin:'http://127.0.0.1:12345',key,boot:await bootStamp()}));
    assert.equal(await viewerLink(id, root), 'http://127.0.0.1:12345/v/' + id + '/' + createHmac('sha256',key).update(id).digest('hex') + '/');
    assert.notEqual(await viewerLink(id, root), await viewerLink('c'.repeat(32), root));
    await assert.rejects(endpoint('../escape', root), /Invalid browser session/);
    await writeFile(root + '/viewer.json', JSON.stringify({origin:'https://external.invalid',key,boot:await bootStamp()}));
    await assert.rejects(viewerLink(id, root), /Invalid browser viewer descriptor/);
    await writeFile(root + '/viewer.json', JSON.stringify({origin:'http://127.0.0.1:12345',key,boot:'previous-boot'}));
    await assert.rejects(viewerLink(id, root), /Reopen this sandbox/);
  } finally { await rm(root, {recursive:true,force:true}); }
});


test('viewer accepts isolated localhost names but rejects lookalikes and external origins', async () => {
  const root = await mkdtemp(tmpdir() + '/pi-viewer-');
  const key = 'b'.repeat(64), id = 'a'.repeat(32);
  const origin = 'http://sbx-' + 'c'.repeat(24) + '.localhost:12345';
  try {
    for (const candidate of [origin, origin.replace('.localhost', '.localhost.evil.test'),
      origin.replace('sbx-', 'other-'), origin.replace('http:', 'https:')]) {
      await writeFile(root + '/viewer.json', JSON.stringify({origin:candidate,key,boot:await bootStamp()}));
      if (candidate === origin) assert.ok((await viewerLink(id, root)).startsWith(origin + '/v/'));
      else await assert.rejects(viewerLink(id, root), /Invalid browser viewer descriptor/);
    }
  } finally { await rm(root, {recursive:true,force:true}); }
});


test('desktop routes accept only a private owned socket in a private real profile',async()=>{
 const root=await mkdtemp(tmpdir()+'/pi-desktop-'),id='d'.repeat(32),directory=root+'/'+id,path=directory+'/desktop.sock';
 const server=createServer();
 try {
  await mkdir(directory,{mode:0o700});
  await writeFile(path,'not a socket',{mode:0o600});
  await assert.rejects(desktopSocket(id,root),/Invalid browser desktop socket/);
  await rm(path);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  await chmod(path,0o600);
  assert.equal(await desktopSocket(id,root),path);
  await chmod(path,0o666);await assert.rejects(desktopSocket(id,root),/Invalid browser desktop socket/);
  await chmod(path,0o600);await chmod(directory,0o755);
  await assert.rejects(desktopSocket(id,root),/Invalid browser profile/);
  await chmod(directory,0o700);
  const alias='e'.repeat(32);await symlink(directory,root+'/'+alias);
  await assert.rejects(desktopSocket(alias,root),/Invalid browser profile/);
  await assert.rejects(desktopSocket('../escape',root),/Invalid browser session/);
 } finally {if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
});
