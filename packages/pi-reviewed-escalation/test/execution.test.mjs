import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const extension = await jiti.import('../index.ts',{default:true});
const { BoundaryApprovalBroker } = await jiti.import('../../pi-auto-review/src/broker/broker.ts');
const symbol = Symbol.for('pi-auto-review:boundary-approval-broker');

for (const outcome of ['allow','deny','defer']) {
  test(`actual shell runs only after ${outcome === 'defer' ? 'explicit UI confirmation of a deferral' : outcome === 'allow' ? 'reviewer grant consumption' : 'approval (denial must never execute)'}`, async () => {
    const cwd=mkdtempSync('/tmp/escalation-execution-cwd-');
    const outside=mkdtempSync('/tmp/escalation-execution-outside-');
    const file=join(outside,'probe');
    const command=`echo execution-ok > '${file}'`;
    const original=globalThis[symbol];
    let prompted=false;
    try {
      globalThis[symbol]=new BoundaryApprovalBroker({reviewer:async request=>{
        assert.equal(request.command,command);
        assert.equal(request.cwd,cwd);
        assert.equal(existsSync(file),false,'host must not run before review');
        return {outcome,riskLevel:'low',userAuthorization:'high',rationale:'Isolated test decision.'};
      }});
      let tool;
      const entries=[];
      extension({on(){},registerTool(value){tool=value;},appendEntry(name,entry){entries.push({name,entry});}});
      assert.ok(tool);
      const ctx={cwd,sessionManager:{getSessionId(){return 'test-session';},getSessionFile(){return undefined;}},hasUI:true,ui:{select:async(title,choices)=>{
        assert.equal(outcome,'defer','allow and deny must never ask a user');
        assert.ok(title.includes(command));
        assert.ok(title.includes(cwd));
        assert.match(title,/OUTSIDE the sandbox/);
        assert.equal(existsSync(file),false,'host must not run before human approval');
        prompted=true;
        return choices[0];
      }}};
      const result=await tool.execute('test-tool-call',{command,justification:'Disposable outside-workspace test.',timeout:10},new AbortController().signal,undefined,ctx);
      assert.equal(existsSync(file),outcome!=='deny');
      if(outcome==='deny') assert.equal(result.isError,true);
      else assert.equal(readFileSync(file,'utf8'),'execution-ok\n');
      assert.equal(prompted,outcome==='defer');
      assert.equal(entries[0].entry.allowed,outcome!=='deny');
    } finally {
      globalThis[symbol]=original;
      rmSync(cwd,{recursive:true,force:true});
      rmSync(outside,{recursive:true,force:true});
    }
  });
}

test('the host tool is absent from sandboxed workers',()=>{
  const original=process.env.PI_SANDBOX_SUBAGENT_DEPTH;
  try {
    process.env.PI_SANDBOX_SUBAGENT_DEPTH='1';
    extension({registerTool(){throw new Error('must not register');}});
  } finally {
    if(original===undefined) delete process.env.PI_SANDBOX_SUBAGENT_DEPTH;
    else process.env.PI_SANDBOX_SUBAGENT_DEPTH=original;
  }
});
