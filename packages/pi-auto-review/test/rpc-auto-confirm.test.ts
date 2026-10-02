import assert from 'node:assert/strict';
import test from 'node:test';
import {PermissionUiAutoConfirmer} from '../src/ui-auto-confirm.ts';

const options=['Yes','Yes, allow reads to 3 paths for this session','Yes, allow reads and writes to 3 paths for this session','No','No, provide reason'];
const value='ls -la ~/.slack-mcp 2>/dev/null; ls -la ~/.config/slack* 2>/dev/null; find ~ -maxdepth 4 -name channelcache';
const event=(surface='external_directory_read',requestId='request-1')=>({requestId,request:{surface,value},surface:'bash',value});
const title=(surface='external_directory_read')=>`Permission Required\ntool : bash\nsurface : ${surface}\nrule : *\ncommand : ${value}\nexternal path : /home/kyuz0/.slack-mcp`;

function setup(stage=true,enabled: readonly string[]=['external_directory','path']) {
  const humanCalls: unknown[][]=[];
  const original=async (...args: unknown[])=>{humanCalls.push(args);return 'No';};
  const ctx={mode:'rpc',hasUI:true,ui:{select:original}};
  const confirmer=new PermissionUiAutoConfirmer(()=>enabled);
  if(stage) assert.equal(confirmer.stage('request-1','external_directory_read'),enabled.length>0);
  return {ctx,confirmer,original,humanCalls};
}

test('RPC model allow approves the exact ask once, never a session grant',async()=>{
  const {ctx,confirmer,original,humanCalls}=setup();
  confirmer.handlePrompt(event(),ctx as never);
  assert.equal(await ctx.ui.select(title(),options),'Yes');
  assert.equal(humanCalls.length,0);
  assert.equal(ctx.ui.select,original);
  assert.equal(await ctx.ui.select(title(),options),'No');
  assert.equal(humanCalls.length,1);
});

const mismatchCases: [string, unknown, string, string[]][] = [
  ['request id mismatch',event('external_directory_read','other-request'),title(),options],
  ['read approval cannot approve write',event('external_directory_write'),title('external_directory_write'),options],
  ['mismatched rendered surface',event(),title('external_directory_write'),options],
  ['mismatched rendered command',event(),title().replace(value,'cat /unreviewed/file'),options],
  ['unrelated selection',event(),'Choose a deployment target',options],
  ['unexpected choices',event(),title(),['Allow','Deny']],
  ['missing structured surface',{requestId:'request-1',value},title(),options],
];
for(const [name,evt,prompt,choices] of mismatchCases) test(`RPC ${name} leaves the human in control`,async()=>{
  const {ctx,confirmer,humanCalls}=setup();
  confirmer.handlePrompt(evt,ctx as never);
  assert.equal(await ctx.ui.select(prompt,choices),'No');
  assert.equal(humanCalls.length,1);
});

test('RPC wrapped command can match the rendered permission prompt',async()=>{
  const {ctx,confirmer,humanCalls}=setup();
  confirmer.handlePrompt(event(),ctx as never);
  const wrapped=title().replace(value,value.slice(0,57)+'\n'+value.slice(57));
  assert.equal(await ctx.ui.select(wrapped,options),'Yes');
  assert.equal(humanCalls.length,0);
});

for(const staged of [false,true]) test(`RPC ${staged?'disabled':'unstaged'} approval does not auto-confirm`,async()=>{
  const {ctx,confirmer,humanCalls}=setup(staged,staged?[]:undefined);
  confirmer.handlePrompt(event(),ctx as never);
  assert.equal(await ctx.ui.select(title(),options),'No');
  assert.equal(humanCalls.length,1);
});

test('RPC stale interceptor expires before a later unrelated select',async()=>{
  const {ctx,confirmer,original,humanCalls}=setup();
  confirmer.handlePrompt(event(),ctx as never);
  await Promise.resolve();
  assert.equal(ctx.ui.select,original);
  assert.equal(await ctx.ui.select(title(),options),'No');
  assert.equal(humanCalls.length,1);
});

test('RPC cancellation clears an installed interceptor',async()=>{
  const {ctx,confirmer,original}=setup();
  confirmer.handlePrompt(event(),ctx as never);
  confirmer.clear();
  assert.equal(ctx.ui.select,original);
  assert.equal(await ctx.ui.select(title(),options),'No');
});

test('RPC event alone cannot approve a model denial or deferral',async()=>{
  const {ctx,confirmer,humanCalls}=setup(false);
  confirmer.handlePrompt(event(),ctx as never);
  assert.equal(await ctx.ui.select(title(),options),'No');
  assert.equal(humanCalls.length,1);
});
