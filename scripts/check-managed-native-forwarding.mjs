import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Run against the installed, prepared package. The optional directory allows
// testing a disposable copy of the pinned dependency before image assembly.
const directory = process.argv[2] ?? fileURLToPath(new URL("../node_modules/@gotgenes/pi-permission-system", import.meta.url));
const loader = createJiti(import.meta.url);
const load = (name) => loader.import(resolve(directory, "src/authority", name + ".ts"));
const { SubagentSessionRegistry } = await load("subagent-registry");
const { resolvePermissionForwardingTarget } = await load("permission-forwarding");
const { ForwardingLivenessJudge } = await load("forwarding-liveness");
const { selectAuthorizer } = await load("authorizer");
const { ParentAuthorizer } = await load("approval-escalator");
const { ForwardedRequestServer } = await load("forwarded-request-server");
const registry = new SubagentSessionRegistry();
const children = new Map([
  ["foreground", { rootSessionId: "root", nativeApprovalGeneration: "generation", agent: "worker" }],
  ["background", { rootSessionId: "root", nativeApprovalGeneration: "generation", agent: "worker" }],
  ["nested", { rootSessionId: "root", nativeApprovalGeneration: "generation", agent: "nested-worker" }],
  ["unavailable", {}],
]);

globalThis[Symbol.for("pi-subagents:approval-child-sessions")] = children;
const judge = new ForwardingLivenessJudge({
  registry: { isServing: () => false, servingIds: () => [] },
  heartbeats: { read: id => id === "root" ? "alive" : "absent" },
});
function target(id) {
  return resolvePermissionForwardingTarget({
    isSubagent: true, currentSessionId: id, sessionId: id, registry,
    env: { PI_SUBAGENT_PARENT_SESSION: "unrelated" },
  });
}
try {
  for (const child of ["foreground", "background", "nested"]) {
    assert.equal(registry.has(child), true);
    assert.deepEqual(target(child), { source: "managed-runtime", sessionId: "root" });
    assert.equal(judge.isServing(target(child)), true);
    for (const hasUI of [true, false]) {
      const selection = selectAuthorizer({ hasUI, sessionManager: { getSessionId: () => child } }, { registry });
      assert.equal(selection.adjudicatesLocally, false);
    }
  }
  assert.equal(registry.get("nested").managedAgent, "nested-worker");
  children.delete("foreground");
  assert.equal(registry.has("foreground"), false);
  assert.equal(registry.has("background"), true);
  assert.equal(target("unavailable"), null);
  const missing = selectAuthorizer({ hasUI: false, sessionManager: { getSessionId: () => "unavailable" } }, { registry });
  assert.equal(missing.adjudicatesLocally, false);
  await verifyFileExchange();
  console.log("Managed native routing, file exchange, branch invalidation and cancellation passed.");
} finally {
  delete globalThis[Symbol.for("pi-subagents:approval-child-sessions")];
}

async function verifyFileExchange() {
  process.env.PI_SANDBOX_CONTAINER = "1";
  process.env.SANDBOX_SUBAGENTS = "1";
  const dir = await mkdtemp(join(tmpdir(), "pi-managed-native-"));
  const generations = new Map([["root", "generation"]]);
  globalThis[Symbol.for("pi-subagents:native-approval-generations")] = generations;
  const file = "/workspace/fixture.txt";
  const logger = { review() {}, debug() {}, warning() {}, error() {} };
  const root = { sessionManager: { getSessionId: () => "root" } };
  try {
    for (const scenario of ["allow", "already-switched", "switch-during-prompt", "cancel"]) {
      generations.set("root", scenario === "already-switched" ? "next-branch" : "generation");
      const cancel = new AbortController();
      const worker = new ParentAuthorizer({
        cwd: "/workspace/worker", sessionManager: { getSessionId: () => "background" }, signal: cancel.signal,
      }, { forwardingDir: dir, registry, serving: judge, getTimeoutMs: () => 5000, logger });
      let calls = 0;
      const server = new ForwardedRequestServer({
        forwardingDir: dir, registry, logger, policy: { resolve: () => ({ state: "ask" }) },
        broadcaster: { emitDecision() {} }, recorder: { recordSessionApproval: () => assert.fail("unexpected session grant") },
        escalator: { async escalate(details) {
          calls++;
          assert.equal(details.forwarding.requesterSessionId, "background");
          assert.equal(details.forwarding.requesterAgentName, "worker");
          assert.equal(details[Symbol.for("pi-auto-review:forwarded-cwd")], "/workspace/worker");
          assert.deepEqual(details.accessIntent.matchValues, [file]);
          if (scenario === "switch-during-prompt") generations.set("root", "next-branch");
          if (scenario === "cancel") cancel.abort();
          if (scenario === "switch-during-prompt" || scenario === "cancel") {
            const signal = details[Symbol.for("pi-auto-review:forwarded-signal")];
            await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
          }
          return { approved: true, state: "approved", decidedBy: { kind: "user", via: "select" } };
        } },
      });
      const pending = worker.authorize({ requestId: randomUUID(), source: "tool_call", toolName: "read",
        surface: "read", value: file, payload: { request: { surface: "external_directory_read" } },
        accessIntent: { surface: "external_directory_read", matchValues: [file], boundaryValue: file } });
      await server.processInbox(root);
      const result = await pending;
      assert.equal(result.approved, scenario === "allow", scenario);
      assert.equal(calls, scenario === "already-switched" ? 0 : 1, scenario);
    }
  } finally {
    delete globalThis[Symbol.for("pi-subagents:native-approval-generations")];
    await rm(dir, { recursive: true, force: true });
  }
}
