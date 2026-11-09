import assert from "node:assert/strict";
import test from "node:test";
import { BoundaryApprovalBroker } from "../src/broker/broker.ts";
import { getBoundaryBroker, publishBoundaryBroker } from "../src/broker/service.ts";
import type { BoundaryRequest, BoundaryReview } from "../src/broker/types.ts";
const request: BoundaryRequest = {id:"test",source:"sandbox-runtime",surface:"command",operation:"execute",cwd:"/workspace",command:"printf test"};
const review = (label: string, outcome: "allow" | "deny" = "allow"): BoundaryReview => ({outcome,riskLevel:"low",userAuthorization:"high",rationale:label});
const context = (sessionId: string) => ({sessionId,scopeKey:"turn",issueGrant:true});

test("overlapping sessions keep their own reviewer and survive disposal in either order", async () => {
  for (const first of ["a", "b"]) {
    const seen: string[] = [];
    const a = new BoundaryApprovalBroker({reviewer:async()=>{seen.push("a");return review("a");}});
    const b = new BoundaryApprovalBroker({reviewer:async()=>{seen.push("b");return review("b", "deny");}});
    const dispose = {a:publishBoundaryBroker(a,()=>"a"),b:publishBoundaryBroker(b,()=>"b")};
    try {
      const service=getBoundaryBroker()!;
      assert.equal((await service.review(request, context("a"))).kind,"allow");
      assert.equal((await service.review(request, context("b"))).kind,"deny");
      assert.deepEqual(seen,["a","b"]);
      assert.equal((await service.review(request, context("unknown"))).kind,"deny");
      assert.deepEqual(seen,["a","b"]);
      dispose[first as "a"|"b"]();
      const remaining=first==="a"?"b":"a";
      assert.ok(getBoundaryBroker());
      assert.equal((await service.review(request,context(remaining))).review.rationale,remaining);
      assert.equal((await service.review(request,context(first))).kind,"deny");
    } finally {dispose.a();dispose.b();}
    assert.equal(getBoundaryBroker(),undefined);
  }
});

test("grants stay with their session and cannot survive disposal or replacement", async()=>{
  const a = new BoundaryApprovalBroker({reviewer:async()=>review("a")});
  const b = new BoundaryApprovalBroker({reviewer:async()=>review("b")});
  const endA=publishBoundaryBroker(a,()=>"a"),endB=publishBoundaryBroker(b,()=>"b");
  let endReplacement=()=>{};
  try {
    const service=getBoundaryBroker()!;
    const result=await service.review(request,context("a"));
    assert.ok(result.kind==="allow" && result.grant);
    const token=result.grant.token;
    assert.equal(service.consumeGrant(request,"b",token),false);
    endA();
    endReplacement=publishBoundaryBroker(new BoundaryApprovalBroker({reviewer:async()=>review("replacement")}),()=>"a");
    assert.equal(service.consumeGrant(request,"a",token),false);
    assert.equal((await service.review(request,context("a"))).review.rationale,"replacement");
  } finally {endA();endB();endReplacement();}
});

test("ambiguous owners for the same session fail closed",async()=>{
  let calls=0;
  const make=()=>new BoundaryApprovalBroker({reviewer:async()=>{calls++;return review("allowed");}});
  const endA=publishBoundaryBroker(make(),()=>"same"),endB=publishBoundaryBroker(make(),()=>"same");
  try {assert.equal((await getBoundaryBroker()!.review(request,context("same"))).kind,"deny");assert.equal(calls,0);}
  finally {endA();endB();}
});

test("a review finishing after its session closes cannot allow execution",async()=>{
  let resolve!: (value: BoundaryReview)=>void;
  let started!: ()=>void;
  const entered=new Promise<void>(r=>{started=r;});
  const broker=new BoundaryApprovalBroker({reviewer:()=>{started();return new Promise(r=>{resolve=r;});}});
  const end=publishBoundaryBroker(broker,()=>"a");
  const service=getBoundaryBroker()!;
  const pending=service.review(request,context("a"));
  await entered;end();resolve(review("old"));
  assert.equal((await pending).kind,"deny");
});

test("session ID changes route only to the current ID",async()=>{
  let id="old";
  const end=publishBoundaryBroker(new BoundaryApprovalBroker({reviewer:async()=>review("current")}),()=>id);
  try {
    const service=getBoundaryBroker()!;id="new";
    assert.equal((await service.review(request,context("old"))).kind,"deny");
    assert.equal((await service.review(request,context("new"))).kind,"allow");
  } finally {end();}
});
