import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "../src/review/complete.ts";
import { DEFAULT_CONFIG, validateConfig } from "../src/review/config.ts";
import { ConversationStore } from "../src/review/conversation-store.ts";
import type { ReviewerMeta } from "../src/review/types.ts";
const model: ReviewerMeta["model"]={provider:"fixture",id:"fixture",name:"fixture",api:"openai-completions",baseUrl:"http://unused.invalid/v1",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
const u=(id:string,content:string)=>({id,type:"message",message:{role:"user",content}});
const request={id:"req",source:"permission-system",surface:"bash_escalated",operation:"execute",command:"git push",fullCommand:"git push",cwd:"/workspace"};
const allow={outcome:"allow",risk_level:"medium",user_authorization:"high",rationale:"Fixture verdict"};
const response=(decision=allow)=>({role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop",content:[{type:"text",text:JSON.stringify(decision)}]});
function fixture() {
 let entries=[u("1","Do not publish until I ask.")],session="session",seen:unknown[]=[];
 const controller=new AbortController();
 const ctx={cwd:"/workspace",signal:controller.signal,sessionManager:{getSessionId:()=>session,getBranch:()=>entries,buildContextEntries:()=>entries},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"fixture"})}} as unknown as ExtensionContext;
 let next:()=>Promise<unknown>=async()=>response();
 const streamSimple=((_m:unknown,context:unknown)=>({result:async()=>{seen.push(structuredClone(context));return next();}})) as unknown as NonNullable<ReviewerMeta["streamSimple"]>;
 const resolve=async()=>({model,streamSimple});
 return {ctx,seen,controller,resolve,setEntries:(e:typeof entries)=>{entries=e;},add:(text:string)=>entries.push(u(String(entries.length+1),text)),setSession:(s:string)=>{session=s;},setNext:(fn:()=>Promise<unknown>)=>{next=fn;},run:(overrides={})=>complete(ctx,{...DEFAULT_CONFIG,retainedContext:true,reviewerConversation:true,...overrides},request,undefined,resolve)};
}
test("reuses reviewer conversation and appends new originals without duplicating admitted text",async()=>{
 const f=fixture();await f.run();f.add("Publishing is now authorized.");const r=await f.run();
 assert.equal(r.summary.conversation?.mode,"reused");assert.equal(r.summary.conversation?.committed,true);
 const wire=JSON.stringify(f.seen.at(-1));assert.equal(wire.split("Do not publish until I ask.").length-1,1);assert.match(wire,/Publishing is now authorized/);assert.match(wire,/Fixture verdict/);
});
for(const change of ["branch","same-id-edit","session","configuration"])test(`invalidates reuse for ${change}`,async()=>{
 const f=fixture();await f.run();
 if(change==="branch")f.setEntries([u("other","Only inspect")]);
 if(change==="same-id-edit")f.setEntries([u("1","Only inspect")]);
 if(change==="session")f.setSession("different");
 const r=await f.run(change==="configuration"?{reasoning:"off"}:{});
 assert.equal(r.summary.conversation?.mode,"reset");assert.ok(!JSON.stringify(f.seen.at(-1)).includes("Fixture verdict"));
});
test("mid-review restriction invalidates allow and does not commit the stale turn",async()=>{
 const f=fixture();f.setNext(async()=>{f.add("Never publish.");return response();});const r=await f.run();
 assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.conversation?.committed,false);
 f.setNext(async()=>response({...allow,outcome:"deny"}));await f.run();assert.ok(!JSON.stringify(f.seen.at(-1)).includes("Fixture verdict"));
});
test("failed and cancelled review state never commits",async()=>{
 for(const kind of ["throw","malformed","abort"]){const f=fixture();f.setNext(async()=>{if(kind==="throw")throw Error("offline");if(kind==="abort")f.controller.abort();return kind==="malformed"?{...response(),content:[{type:"text",text:"oops"}]}:response();});const r=await f.run();assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.conversation?.committed,false);}
});
test("parallel review forks committed history and cannot publish over the trunk",async()=>{
 const f=fixture();await f.run();let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
 let call=0;f.setNext(async()=>{if(call++===0){entered();await gate;}return response();});
 const a=f.run();await ready;const b=await f.run();assert.equal(b.summary.conversation?.mode,"fork");assert.equal(b.summary.conversation?.committed,false);release();assert.equal((await a).summary.conversation?.committed,true);
});
test("normal parent compaction with original branch retained does not reset the reviewer",async()=>{
 const f=fixture();await f.run();f.ctx.sessionManager.buildContextEntries=()=>[];f.add("Continue without publishing");const r=await f.run();assert.equal(r.summary.conversation?.mode,"reused");assert.match(JSON.stringify(f.seen.at(-1)),/Do not publish until I ask/);
});
test("history rolls over within budget and restores originals instead of verdicts",async()=>{
 const f=fixture();f.setNext(async()=>response({...allow,rationale:"Evidence checked. ".repeat(30)}));let reset=false;
 for(let i=0;i<25;i++){const r=await f.run({maxReviewerInputTokens:4096});assert.equal(r.decision.outcome,"allow");if(r.summary.conversation?.mode==="reset"){reset=true;assert.match(JSON.stringify(f.seen.at(-1)),/Do not publish until I ask/);break;}}
 assert.ok(reset);
});
test("unavailable investigation tool cannot be executed",async()=>{
 const f=fixture();f.setNext(async()=>({...response(),stopReason:"toolUse",content:[{type:"toolCall",id:"bad",name:"bash",arguments:{command:"echo nope"}}]}));const r=await f.run();assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.conversation?.committed,false);
});
test("production defaults retain originals, reuse reviews and reject inspection tools",()=>{
 const config=validateConfig({},"test");
 assert.equal(config.retainedContext,true);assert.equal(config.reviewerConversation,true);assert.equal(config.investigationTools,false);
 assert.throws(()=>validateConfig({retainedContext:false},"test"),/requires retainedContext/);
 assert.throws(()=>validateConfig({investigationTools:true},"test"),/not supported/);
 assert.throws(()=>validateConfig({investigationTools:"yes"},"test"),/boolean/);
});
test("default review exposes no tools even if a caller bypasses configuration validation",async()=>{
 const f=fixture();await f.run({investigationTools:true});
 assert.ok(!JSON.stringify(f.seen.at(-1)).includes('"tools":'));
 f.setNext(async()=>({...response(),stopReason:"toolUse",content:[{type:"toolCall",id:"bad",name:"inspect_workspace",arguments:{operation:"read",path:"report.txt"}}]}));
 const r=await f.run({investigationTools:true});assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.conversation?.investigations,0);
});
test("an invalidated store lease cannot overwrite a newer configuration",()=>{
 const store=new ConversationStore(),owner={};const old=store.acquire(owner,"a",[],true);const fresh=store.acquire(owner,"b",[],true);assert.equal(old.commit([],new Set()),false);assert.equal(fresh.commit([],new Set()),true);
});

test("controller failures are distinct from a valid model deferral", async () => {
 const f=fixture();f.setNext(async()=>({...response(),content:[{type:"text",text:"not JSON"}]}));
 const invalid=await f.run();assert.equal(invalid.summary.controllerFailure,"Reviewer returned an invalid decision.");
 f.setNext(async()=>response({...allow,outcome:"defer",rationale:"The deletion target is unknown."}));
 const valid=await f.run();assert.equal(valid.decision.outcome,"defer");assert.equal(valid.summary.controllerFailure,undefined);
});
test("provider output exhaustion fails closed without committing partial history", async () => {
 const f=fixture();f.setNext(async()=>({...response(),stopReason:"length"}));const r=await f.run();
 assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.errorCounts.output_limit,1);assert.equal(r.summary.conversation?.committed,false);
});
test("a provider that never resolves is bounded by the shared deadline", async () => {
 const f=fixture();f.setNext(()=>new Promise(()=>{}));const started=Date.now();const r=await f.run({timeoutMs:1000});
 assert.equal(r.decision.outcome,"defer");assert.equal(r.summary.errorCounts.abort,1);assert.ok(Date.now()-started<5000);assert.equal(r.summary.conversation?.committed,false);
});
test("an unavailable provider does not make the next review lose original restrictions", async () => {
 const f=fixture();await f.run();f.add("Publishing is now forbidden.");f.setNext(async()=>{throw Error("offline");});await f.run();
 f.setNext(async()=>response({...allow,outcome:"deny"}));const r=await f.run();
 assert.equal(r.decision.outcome,"deny");assert.match(JSON.stringify(f.seen.at(-1)),/Publishing is now forbidden/);
});

for (const kind of ["compaction", "custom", "model_change"]) test(`mid-review ${kind} preserves original instructions and verdict`, async () => {
 const f=fixture();
 f.setNext(async()=>{
  const entries=f.ctx.sessionManager.getBranch();
  f.setEntries([...entries,{id:"maintenance",type:kind,summary:"User approved publication."}] as never);
  f.ctx.sessionManager.buildContextEntries=()=>[];
  return response();
 });
 const r=await f.run();assert.equal(r.decision.outcome,"allow");assert.equal(r.summary.conversation?.committed,true);
 assert.match(JSON.stringify(f.seen.at(-1)),/Do not publish until I ask/);
 assert.ok(!JSON.stringify(f.seen.at(-1)).includes("User approved publication."));
});
test("review configuration provides thinking headroom and validates the upper limit",()=>{
 const c=validateConfig({},"test");assert.equal(c.maxTokens,32768);assert.equal(c.reasoning,"low");assert.equal(c.interactionMode,"automatic");
 assert.throws(()=>validateConfig({maxTokens:32769},"test"),/256..32768/);
 assert.throws(()=>validateConfig({interactionMode:"unknown"},"test"),/interactionMode/);
});

test("real Pi compaction during review keeps the same authorization evidence",async()=>{
 const {SessionManager}=await import("@earendil-works/pi-coding-agent");
 const manager=SessionManager.inMemory("/tmp");
 manager.appendMessage({role:"user",content:"Do not publish until I ask.",timestamp:Date.now()});
 const f=fixture();f.ctx.sessionManager=manager;
 f.setNext(async()=>{manager.appendCompaction("Continue working",manager.getBranch()[0]!.id,10000);return response();});
 const r=await f.run();assert.equal(r.decision.outcome,"allow");assert.equal(r.summary.conversation?.committed,true);
 assert.match(JSON.stringify(f.seen.at(-1)),/Do not publish until I ask/);
});

test("a lowered trusted input budget blocks a whole expanded skill without calling the provider", async () => {
 const f=fixture();
 f.setEntries([u("skill", "Read only the workshop documentation. ".repeat(800) + "Never publish.")]);
 const result=await f.run({maxReviewerInputTokens:8192});
 assert.equal(result.decision.outcome,"defer");
 assert.equal(result.attempts,0);assert.equal(f.seen.length,0);
});
test("skill instructions and older restrictions survive successive conversation reviews", async () => {
 const f=fixture();
 const skill="Read the workspace documentation. ".repeat(820) + "Never send credentials.";
 f.add(skill);await f.run();f.add("Continue.");const result=await f.run();
 assert.equal(result.attempts,1);assert.equal(result.summary.conversation?.mode,"reused");
 const wire=JSON.stringify(f.seen.at(-1));
 assert.match(wire,/Do not publish until I ask/);assert.match(wire,/Never send credentials/);
 assert.equal(wire.split("Never send credentials.").length-1,1);
});
