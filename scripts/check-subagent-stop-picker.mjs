import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "subagent-stop-picker-"));
process.env.PI_SUBAGENTS_TEMP_ROOT = root;
const source = resolve(process.argv[2] ?? "node_modules/pi-subagents", "src");
const load = name => import(pathToFileURL(join(source, name)).href);

try {
  const { DIRS } = await load("shared/types.js");
  const { registerSlashCommands } = await load("slash/slash-commands.js");
  const { updateActiveRunIndex } = await load("runs/background/active-run-index.js");
  const { scheduledRunStorePath } = await load("runs/background/scheduled-runs.js");
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  for (const [id, name] of [
    ["aaaa0001-0000-4000-8000-000000000001", "Atlas"],
    ["bbbb0002-0000-4000-8000-000000000002", "Atlas"],
    ["cccc0003-0000-4000-8000-000000000003", "Birch"],
  ]) {
    const dir = join(DIRS.async, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "status.json"), JSON.stringify({
      runId: id, sessionId: "parent", cwd: root, mode: "single", state: "running",
      pid: process.pid, startedAt: now, lastUpdate: now, steps: [{ label: name, agent: "assistant", status: "running" }],
    }));
    updateActiveRunIndex(dir, "running");
  }
  const scheduleDir = join(scheduledRunStorePath(root), "example");
  mkdirSync(scheduleDir, { recursive: true });
  writeFileSync(join(scheduleDir, "schedule.json"), JSON.stringify({
    schemaVersion: 1, id: "example", name: "Daily report", cwd: root, createdAt: timestamp,
    updatedAt: timestamp, paused: false, overlap: "skip", catchUp: "none",
    trigger: { kind: "once", at: timestamp, nextRunAt: timestamp },
    target: { workflowScript: "report.js", args: {} },
  }));

  const commands = new Map();
  registerSlashCommands({ registerCommand: (name, command) => commands.set(name, command) }, { currentSessionId: "parent" });
  let choices, confirmation;
  const ctx = {
    cwd: root, mode: "rpc", hasUI: true, isIdle: () => true,
    ui: {
      select(_title, options) { choices = options; return "Atlas (bbbb0002)"; },
      confirm(_title, message) { confirmation = message; return false; },
      notify(message) { throw new Error(message); },
    },
  };
  const expected = ["Stop all 3 background workers", "Atlas (aaaa0001)", "Atlas (bbbb0002)", "Birch"];
  await commands.get("subagents-stop-picker-rpc").handler("", ctx);
  assert.deepEqual([...choices].sort(), [...expected].sort());
  assert.equal(confirmation, "Stop Atlas (bbbb0002) in this session?");
  await commands.get("subagents-stop").handler("", ctx);
  assert.deepEqual([...choices].sort(), [...expected, "Pause schedule · example · Daily report"].sort());
  console.log("PASS unique and duplicate worker names, exact selected label and schedule visibility");
} finally {
  rmSync(root, { recursive: true, force: true });
}
