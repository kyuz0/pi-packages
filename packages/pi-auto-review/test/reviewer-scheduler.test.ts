import assert from "node:assert/strict";
import test from "node:test";
import {withReviewerSlot} from "../src/review/scheduler.ts";
import {retryDelayMs} from "../src/review/provider.ts";
import {reviewerFailure} from "../src/broker/reviewer-failure.ts";
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test("a burst of reviews never exceeds one active request per endpoint",async()=>{
 let active=0,peak=0,calls=0;
 const outcomes=await Promise.all(Array.from({length:32},(_,i)=>withReviewerSlot("burst",new AbortController().signal,async()=>{
  active++;peak=Math.max(peak,active);calls++;await delay(2);active--;return i;
 })));
 assert.equal(peak,1);assert.equal(calls,32);assert.deepEqual(outcomes,Array.from({length:32},(_,i)=>i));
});
test("different endpoints proceed independently",async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r);
 const a=withReviewerSlot("a",new AbortController().signal,()=>held);
 assert.equal(await withReviewerSlot("b",new AbortController().signal,async()=>42),42);release();await a;
});
test("cancelled waiter cannot release its predecessor or run its operation",async()=>{
 let release!:()=>void,started=false,third=false;
 const held=new Promise<void>(r=>release=r);
 const a=withReviewerSlot("cancel",new AbortController().signal,()=>held);
 const controller=new AbortController();
 const b=withReviewerSlot("cancel",controller.signal,async()=>{started=true;});
 const c=withReviewerSlot("cancel",new AbortController().signal,async()=>{third=true;});
 controller.abort();await assert.rejects(b,/aborted/);await delay(5);
 assert.equal(started,false);assert.equal(third,false);release();await Promise.all([a,c]);assert.equal(third,true);
});
test("aborted hung provider and thrown provider cannot poison later reviews",async()=>{
 const controller=new AbortController();
 const a=withReviewerSlot("hung",controller.signal,()=>new Promise(()=>{}));
 await delay(1);controller.abort();await assert.rejects(a,/aborted/);
 await assert.rejects(withReviewerSlot("hung",new AbortController().signal,async()=>{throw Error("synthetic");}),/synthetic/);
 assert.equal(await withReviewerSlot("hung",new AbortController().signal,async()=>42),42);
});
test("busy model gets a useful cooldown and preserves retry-after",()=>{
 assert.equal(retryDelayMs("rate_limit",{}),2000);
 assert.equal(retryDelayMs("rate_limit",{retryAfterMs:3500}),3500);
 assert.equal(retryDelayMs("rate_limit",{retryAfterMs:8000}),8000);
 assert.equal(retryDelayMs("rate_limit",{},2),4000);
 assert.equal(retryDelayMs("schema",{}),0);
});
test("failure reasons explain the class without revealing provider payloads",()=>{
 for(const code of ["rate_limit","authentication","timeout","transient_connection","transient_server","schema"]){
  const failure=reviewerFailure({errorClass:code,message:"secret-token"});
  assert.equal(failure.errorClass,code);assert.ok(!failure.reason.includes("secret-token"));assert.ok(failure.reason.length<160);
 }
 assert.match(reviewerFailure({errorClass:"rate_limit"}).reason,/busy.*Retry/);
 assert.equal(reviewerFailure({errorClass:"secret-token"}).errorClass,"reviewer_unavailable");
});
