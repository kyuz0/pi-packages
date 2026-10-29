import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "../src/review/complete.ts";
import { DEFAULT_CONFIG as PRODUCTION_DEFAULT_CONFIG } from "../src/review/config.ts";
const DEFAULT_CONFIG = {...PRODUCTION_DEFAULT_CONFIG, reviewerConversation:false};
import type { ReviewerMeta } from "../src/review/types.ts";
const model: ReviewerMeta["model"]={provider:"fixture",id:"fixture",name:"fixture",api:"openai-completions",baseUrl:"http://unused.invalid/v1",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
const u=(id:string,content:string)=>({id,type:"message",message:{role:"user",content}});
const request={id:"req",source:"permission-system",surface:"bash_escalated",operation:"execute",command:"git push",fullCommand:"git push",cwd:"/workspace"};
const decision={outcome:"allow",risk_level:"medium",user_authorization:"high",rationale:"Fixture allows."};
for(const change of ["none","restriction","branch","same-id-edit","session"]){
 test(`actual complete() revalidates before allow: ${change}`,async()=>{
  let entries=[u("1","Push the docs branch.")],session="a";
  const ctx={sessionManager:{getSessionId:()=>session,getBranch:()=>entries,buildContextEntries:()=>entries},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"fixture"})}} as unknown as ExtensionContext;
  const streamSimple=(()=>({result:async()=>{
   if(change==="restriction")entries=[...entries,u("2","Do not push")];
   if(change==="branch")entries=[u("branch","Keep work local")];
   if(change==="same-id-edit")entries=[u("1","Do not push")];
   if(change==="session")session="b";
   return {stopReason:"stop",content:[{type:"text",text:JSON.stringify(decision)}]};
  }})) as unknown as NonNullable<ReviewerMeta["streamSimple"]>;
  const result=await complete(ctx,{...DEFAULT_CONFIG,retainedContext:true},request,undefined,async()=>({model,streamSimple}));
  assert.equal(result.decision.outcome,change==="none"?"allow":"defer");
 });
}
test("compacted model view keeps raw user messages in the actual provider request",async()=>{
 const original=u("1","Do not publish.");const latest=u("2","Continue.");
 const ctx={sessionManager:{getSessionId:()=>"s",getBranch:()=>[original,latest],buildContextEntries:()=>[latest]},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"fixture"})}} as unknown as ExtensionContext;
 let seen="";
 const streamSimple=((_model:unknown,context:unknown)=>({result:async()=>{seen=JSON.stringify(context);return {stopReason:"stop",content:[{type:"text",text:JSON.stringify({...decision,outcome:"deny"})}]};}})) as unknown as NonNullable<ReviewerMeta["streamSimple"]>;
 const result=await complete(ctx,{...DEFAULT_CONFIG,retainedContext:true},request,undefined,async()=>({model,streamSimple}));
 assert.equal(result.decision.outcome,"deny");assert.match(seen,/Do not publish/);assert.match(seen,/active-session-branch/);
});
test("legacy mode does not require or read raw branch API",async()=>{
 const ctx={sessionManager:{getSessionId:()=>"s",getBranch:()=>{throw Error("must not read");},buildContextEntries:()=>[u("1","Run tests")]},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"fixture"})}} as unknown as ExtensionContext;
 const streamSimple=(()=>({result:async()=>({stopReason:"stop",content:[{type:"text",text:JSON.stringify(decision)}]})})) as unknown as NonNullable<ReviewerMeta["streamSimple"]>;
 const result=await complete(ctx,{...DEFAULT_CONFIG,retainedContext:false},request,undefined,async()=>({model,streamSimple}));assert.equal(result.decision.outcome,"allow");
});

test("omitted latest user instruction defers before calling a model",async()=>{
 const entries=[u("1","Publish the documents"),u("2","x".repeat(9000)+"Do not publish.")];
 const ctx={sessionManager:{getSessionId:()=>"s",getBranch:()=>entries,buildContextEntries:()=>entries}} as unknown as ExtensionContext;
 const result=await complete(ctx,{...DEFAULT_CONFIG,retainedContext:true},request,undefined,async()=>{throw Error("must not call model");});
 assert.equal(result.decision.outcome,"defer");assert.equal(result.attempts,0);assert.match(result.decision.rationale,/newest user message/);
});
