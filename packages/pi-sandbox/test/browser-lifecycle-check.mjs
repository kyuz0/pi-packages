/** Run in a disposable Factory browser image; no inference or account access. */
import assert from 'node:assert/strict';
import {SandboxBrowser} from '/opt/betterwright/browser.mjs';
const browser=new SandboxBrowser(),path=process.env.PATH;
try {
  // The image remains unchanged. Hide setpriv only from this test process's children.
  process.env.PATH='/nonexistent-browser-fixture';
  await assert.rejects(browser.run('return true'),/ENOENT/);
  process.env.PATH=path;
  const result=await browser.run('return 42');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result,42);
  console.log('PASS transient startup failure recovers in the same adapter');
} finally {process.env.PATH=path;await browser.close();}
for(let index=0;index<8;index++){
  const candidate=new SandboxBrowser();
  const pending=candidate.run('return true');
  const first=candidate.close(),second=candidate.close();
  assert.equal(first,second,'Concurrent close calls must share one cleanup');
  await assert.rejects(pending,/Browser is closing/);
  await first;
  const result=await candidate.run('return 17');
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.result,17);
  await candidate.close();
}
console.log('PASS queued start versus close, concurrent close and adapter reuse (8 iterations)');
