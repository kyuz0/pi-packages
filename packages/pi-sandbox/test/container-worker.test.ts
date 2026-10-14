import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareContainerWorker } from "../src/container-worker.ts";
import { createDefaultPolicy } from "../src/policy.ts";

test("managed worker gets private model/config copies, reviews, and cleanup", () => {
  const parent = mkdtempSync(join(tmpdir(), "worker-test-"));
  const policy = createDefaultPolicy(parent);
  assert.equal(prepareContainerWorker({}, policy), undefined);
  try {
    writeFileSync(join(parent, "models.json"), '{"providers":{}}');
    writeFileSync(join(parent, "auth.json"), '{"fixture":"private"}');
    writeFileSync(join(parent, "settings.json"), '{"extensions":["/custom.ts"],"packages":["npm:custom"],"skills":["/opt/skill"]}');
    writeFileSync(join(parent, "APPEND_SYSTEM.md"), 'profile');
    const worker = prepareContainerWorker({ PI_SANDBOX_CONTAINER: "1", PI_CODING_AGENT_DIR: parent }, policy)!;
    try {
      assert.equal(statSync(worker.directory).mode & 0o077, 0);
      assert.equal(readFileSync(join(worker.directory, "auth.json"), "utf8"), '{"fixture":"private"}');
      const settings = JSON.parse(readFileSync(join(worker.directory, "settings.json"), "utf8"));
      assert.equal(settings.extensions.length, 2);
      assert.ok(settings.extensions.every((x: string) => !x.includes('pi-sandbox') && !x.includes('escalation')));
      assert.deepEqual(settings.packages, []);
      assert.deepEqual(settings.skills, ["/opt/skill"]);
      assert.ok(worker.policy.filesystem.allowWrite.includes(worker.directory));
      assert.ok(!policy.filesystem.allowWrite.includes(worker.directory));
      writeFileSync(join(worker.directory, "auth.json"), '{}');
      assert.equal(readFileSync(join(parent, "auth.json"), "utf8"), '{"fixture":"private"}');
    } finally { worker.cleanup(); }
    assert.equal(existsSync(worker.directory), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
