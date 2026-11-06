import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { bootStamp, viewerLink, endpoint } from '../src/browser/viewer.mjs';

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
