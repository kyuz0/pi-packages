import assert from "node:assert/strict";
import { test } from "node:test";
import { BoundaryApprovalBroker } from "../../pi-auto-review/src/broker/broker.ts";
import type { BoundaryApprovalBrokerService } from "@erichll/pi-auto-review/broker";
import { approveEscalation, type EscalationInput } from "../approval.ts";

const input: EscalationInput = {
  command: "printf test",
  justification: "Exercise host approval with no side effects.",
  cwd: "/tmp/project",
  sessionId: "session-a",
  scopeKey: "turn-a",
  toolCallId: "call-a",
};

test("missing broker and missing justification cannot approve", async () => {
  assert.equal((await approveEscalation(input, {})).allowed, false);
  let reviewed = false;
  const broker = new BoundaryApprovalBroker({ reviewer: async () => { reviewed = true; throw new Error("unexpected"); } });
  assert.equal((await approveEscalation({ ...input, justification: " " }, { broker })).allowed, false);
  assert.equal(reviewed, false);
});

test("reviewer allow consumes one exact session-bound grant", async () => {
  let request;
  const broker = new BoundaryApprovalBroker({ reviewer: async (value) => {
    request = value;
    assert.equal(value.surface, "host-ipc");
    assert.equal(value.operation, "execute-host");
    assert.match(value.toolInputPreview!, /OUTSIDE the OS sandbox/);
    return { outcome: "allow", riskLevel: "low", userAuthorization: "high", rationale: "Authorized test." };
  } });
  let consumedToken = "";
  const consume = broker.consumeGrant.bind(broker);
  const service: BoundaryApprovalBrokerService = Object.assign(broker, {
    consumeGrant: ((original) => (value: Parameters<BoundaryApprovalBrokerService["consumeGrant"]>[0], sessionId: string, token: string) => {
      assert.equal(value.command, input.command);
      assert.equal(value.cwd, input.cwd);
      assert.equal(sessionId, input.sessionId);
      consumedToken = token;
      return original(value, sessionId, token);
    })(broker.consumeGrant.bind(broker)),
  });
  assert.equal((await approveEscalation(input, { broker: service })).approvedBy, "reviewer");
  assert.ok(consumedToken);
  assert.equal(consume(request!, input.sessionId, consumedToken), false);
  assert.equal(consume(request!, "another-session", consumedToken), false);
});

test("denial never asks a human to bypass it", async () => {
  const broker = new BoundaryApprovalBroker({ reviewer: async () => ({ outcome: "deny", riskLevel: "high", userAuthorization: "low", rationale: "Not authorized." }) });
  const result = await approveEscalation(input, { broker, confirm: async () => { throw new Error("must not prompt"); } });
  assert.equal(result.allowed, false);
});

test("hard denial cannot be manually overridden", async () => {
  const broker = new BoundaryApprovalBroker({ reviewer: async () => { throw new Error("must not review"); }, hardDeny: () => ({ rule: "test-deny", reason: "Hard restriction." }) });
  assert.equal((await approveEscalation(input, { broker, confirm: async () => { throw new Error("must not prompt"); } })).allowed, false);
});

test("defer requires explicit approval of the exact command", async () => {
  const broker = new BoundaryApprovalBroker({ reviewer: async () => ({ outcome: "defer", riskLevel: "medium", userAuthorization: "unknown", rationale: "Ask the user." }) });
  assert.equal((await approveEscalation(input, { broker })).allowed, false);
  assert.equal((await approveEscalation(input, { broker, confirm: async () => false })).allowed, false);
  const allowed = await approveEscalation(input, { broker, confirm: async (request) => {
    assert.equal(request.command, input.command);
    assert.equal(request.cwd, input.cwd);
    return true;
  } });
  assert.equal(allowed.approvedBy, "human");
});

test("an allow without a valid grant fails closed", async () => {
  for (const valid of [false, true]) {
    const broker = new BoundaryApprovalBroker({ reviewer: async () => ({ outcome: "allow", riskLevel: "low", userAuthorization: "high", rationale: "Approved." }) });
    const service = Object.create(broker) as BoundaryApprovalBrokerService;
    service.review = async (request, context) => {
      const result = await broker.review(request, context);
      if (valid && result.kind === "allow") return { ...result, grant: undefined };
      return result;
    };
    service.consumeGrant = () => false;
    assert.equal((await approveEscalation(input, { broker: service })).allowed, false);
  }
});

test("cancellation while awaiting review blocks execution", async () => {
  const controller = new AbortController();
  const broker = new BoundaryApprovalBroker({ reviewer: async () => {
    controller.abort();
    return { outcome: "allow", riskLevel: "low", userAuthorization: "high", rationale: "Approved." };
  } });
  assert.equal((await approveEscalation(input, { broker, signal: controller.signal })).allowed, false);
});

test("cancellation during human confirmation blocks execution", async () => {
  const controller = new AbortController();
  const broker = new BoundaryApprovalBroker({ reviewer: async () => ({ outcome: "defer", riskLevel: "medium", userAuthorization: "unknown", rationale: "Ask." }) });
  assert.equal((await approveEscalation(input, { broker, signal: controller.signal, confirm: async () => { controller.abort(); return true; } })).allowed, false);
});

test("reviewer failures retain the configured fail-closed behavior", async () => {
  const broker = new BoundaryApprovalBroker({ reviewer: async () => { throw new Error("offline"); } });
  assert.equal((await approveEscalation(input, { broker, confirm: async () => { throw new Error("must not prompt"); } })).allowed, false);
});

test("unexpected broker errors do not authorize", async () => {
  const broker = { review: async () => { throw new Error("broker failure"); } } as unknown as BoundaryApprovalBrokerService;
  await assert.rejects(approveEscalation(input, { broker }), /broker failure/);
});
