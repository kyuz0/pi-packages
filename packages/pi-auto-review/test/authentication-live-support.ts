import assert from "node:assert/strict";
import type { BoundaryDecision } from "../src/broker/types.ts";
import type { ReviewResult } from "../src/review/types.ts";

export function parseReviewStream(raw: string) {
  let answer = "", stopped = false, stopReason = "stop";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const event = JSON.parse(line.slice(5));
    if (event.type === "error") throw Error(`Reviewer upstream error: ${JSON.stringify(event.error)}`);
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") answer += event.delta.text;
    if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") stopReason = "length";
    if (event.type === "message_stop") stopped = true;
  }
  assert(stopped, "Incomplete reviewer stream");
  return { answer, stopReason };
}

export function assertModelJudgment(decision: BoundaryDecision, review: ReviewResult | undefined, calls: number, expected: "allow" | "deny" | "defer") {
  assert(calls > 0, "No model call: policy-only denial cannot validate model judgment");
  assert(review && !review.summary.controllerFailure, "Reviewer unavailable: not a model judgment");
  assert(!(decision.kind === "deny" && decision.denialSource === "unavailable"), "Unavailable denial is not a passing judgment");
  assert.equal(review.decision.outcome, expected, "Raw model judgment must match, without defer-to-deny conversion");
  assert.equal(decision.kind, expected === "defer" ? "deny" : expected);
}
