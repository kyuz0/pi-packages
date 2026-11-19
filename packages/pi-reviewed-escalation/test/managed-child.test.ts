import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { requestChildApproval, serveChildApprovals } from "@erichll/pi-auto-review/managed-child";

const rootId = "12345678-1234-1234-1234-123456789abc";
const childA = "12345678-1234-1234-1234-123456789abd";
const childB = "12345678-1234-1234-1234-123456789abe";

function origin() {
  const key = Symbol.for("pi-subagents:approval-origins");
  const registry = (globalThis as Record<symbol, unknown>)[key] as Map<string, {
    sessionId: string;
    address: string;
  }>;
  const owner = registry.get(rootId);
  assert.ok(owner);
  return owner;
}

function input(sessionId: string, command: string) {
  return { sessionId, scopeKey: "unused-on-wire", turn: 1, toolCallId: "one", command, cwd: "/workspace", justification: "Fixture" };
}

test("each delegated approval carries the exact action and child identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "psf-a-"));
  const requests: Array<[string, string]> = [];
  const stop = await serveChildApprovals(rootId, async (request) => {
    requests.push([request.childSessionId, request.command]);
    return request.childSessionId === childA
      ? { allowed: true, approvedBy: "human", rationale: "Approved once" }
      : { allowed: false, rationale: "Denied" };
  }, directory);
  try {
    const source = { origin: origin(), agent: "assistant" };
    const [a, b] = await Promise.all([
      requestChildApproval(source, input(childA, "printf ONE"), undefined, directory),
      requestChildApproval(source, input(childB, "printf TWO"), undefined, directory),
    ]);
    assert.equal(a.approvedBy, "human");
    assert.equal(b.allowed, false);
    assert.deepEqual(requests.sort(), [[childA, "printf ONE"], [childB, "printf TWO"]]);
    stop();
    assert.equal((await requestChildApproval(source, input(childA, "printf ONE"), undefined, directory)).allowed, false);
  } finally {
    stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancelling a child request aborts the approval handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "psf-a-"));
  let begun!: () => void;
  const started = new Promise<void>(resolve => { begun = resolve; });
  let disconnect!: () => void;
  const disconnected = new Promise<void>(resolve => { disconnect = resolve; });
  const stop = await serveChildApprovals(rootId, async (_request, signal) => {
    begun();
    await once(signal, "abort");
    disconnect();
    return { allowed: false, rationale: "Cancelled" };
  }, directory);
  try {
    const cancel = new AbortController();
    const pending = requestChildApproval({ origin: origin() }, input(childA, "printf ONE"), cancel.signal, directory);
    await started;
    cancel.abort();
    assert.equal((await pending).allowed, false);
    await disconnected;
  } finally {
    stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("approval server refuses a symlinked directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "psf-a-"));
  try {
    await symlink(directory, join(directory, "link"));
    await assert.rejects(serveChildApprovals(rootId, async () => {
      assert.fail("unexpected approval request");
    }, join(directory, "link")), /private session directory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
