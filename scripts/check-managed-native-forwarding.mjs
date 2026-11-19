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
const { AskDialogQueue } = await load("ask-dialog-queue");
const { PermissionServiceLifecycle } = await loader.import(resolve(directory, "src/service/service-lifecycle.ts"));
const { runManagedApprovalDialog } = await loader.import(fileURLToPath(new URL("../packages/pi-reviewed-escalation/dialog-admission.ts", import.meta.url)));
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
  await verifyDialogAdmission();
  // A running Pi root keeps its inbox poller alive. The isolated harness drains
  // it directly, so retain a deadline while awaiting its unref'ed cancellation poll.
  let deadline;
  try {
    await Promise.race([verifyFileExchange(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Managed file exchange did not finish")), 15_000);
    })]);
  } finally {
    clearTimeout(deadline);
  }
  console.log("Managed native routing, shared dialog admission, file exchange, branch invalidation and cancellation passed.");
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

async function verifyDialogAdmission() {
  const id = "mixed-admission";
  const queue = new AskDialogQueue();
  const service = {};
  queue.exposeManagedAdmission(service);
  const lifecycle = new PermissionServiceLifecycle(service, { adjudicatesLocally: () => true }, { emit() {} }, []);
  const unavailable = () => assert.fail("unavailable approval queue displayed a dialog");
  assert.equal(await runManagedApprovalDialog(id, unavailable), false);
  lifecycle.activate({ sessionManager: { getSessionId: () => id } });
  const events = [];
  const nativeChoice = Promise.withResolvers();
  const typedConfirmation = Promise.withResolvers();
  const bashDisplayed = Promise.withResolvers();
  const native = queue.run(async () => {
    events.push("native displayed");
    return nativeChoice.promise;
  }, () => false);
  const bash = runManagedApprovalDialog(id, async () => {
    events.push("bash displayed");
    bashDisplayed.resolve();
    await typedConfirmation.promise;
    events.push("bash confirmed");
    return true;
  });
  const nextNative = queue.run(async () => { events.push("next native displayed"); return false; }, () => false);
  await new Promise(setImmediate);
  assert.deepEqual(events, ["native displayed"]);
  assert.equal(await runManagedApprovalDialog("other-session", unavailable), false);
  nativeChoice.resolve(false);
  await bashDisplayed.promise;
  assert.deepEqual(events, ["native displayed", "bash displayed"]);
  typedConfirmation.resolve();
  assert.deepEqual(await Promise.all([native, bash, nextNative]), [false, true, false]);
  assert.deepEqual(events, ["native displayed", "bash displayed", "bash confirmed", "next native displayed"]);

  const visible = Promise.withResolvers();
  const userResponse = Promise.withResolvers();
  const inFlight = queue.run(async () => { visible.resolve(); return userResponse.promise; }, () => false);
  await visible.promise;
  const queued = runManagedApprovalDialog(id, unavailable);
  queue.releaseAll("Session ended");
  lifecycle.teardown();
  assert.deepEqual(await Promise.all([inFlight, queued]), [false, false]);
  assert.equal(await runManagedApprovalDialog(id, unavailable), false);
  userResponse.resolve(true);
}
