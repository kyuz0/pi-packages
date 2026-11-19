import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = resolve(process.argv[2] ?? "node_modules/pi-subagents", "src");
const load = (name) => import(pathToFileURL(resolve(source, name)).href);
const { normalizePublicSubagentExecution } = await load("extension/public-execution.js");
const { flattenSubagentToolOptions } = await load("extension/subagent-options.js");
const { SubagentParams } = await load("extension/schemas.js");
const { projectAsyncStatusSnapshot } = await load("runs/shared/async-status-projection.js");
const { buildWidgetLines, renderSubagentSummary } = await load("tui/render.js");
const { default: registerRuntime } = await load("runs/shared/subagent-prompt-runtime.js");
const { childSupervisorMetadata } = await load("runs/shared/child-runtime-config.js");

const task = "Synthetic task text";
const launch = { agent: "assistant", task };
const name = "Équipe Atlas (2)";
assert.ok(SubagentParams.properties.name);
for (const params of [{ ...launch, name }, { ...launch, options: { name } }]) {
  const normalized = normalizePublicSubagentExecution(flattenSubagentToolOptions(params));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.params.name, name);
  assert.equal(normalized.params.agent, launch.agent);
}
for (const invalid of ["", "A\nB", "A\u202eB", "<A>", "A".repeat(81)]) {
  assert.equal(normalizePublicSubagentExecution({ ...launch, name: invalid }).ok, false);
}
assert.equal(normalizePublicSubagentExecution(launch).params.name, undefined);
assert.equal(flattenSubagentToolOptions({ action: "schedule.create", options: { name: "test schedule" } }).name, "test schedule");

const theme = { fg: (_color, text) => text, bold: text => text, dim: text => text };
function job(id, label, status) {
  return {
    asyncId: id, agents: ["assistant"], mode: "single", chainStepCount: 1, stepsTotal: 1, status, startedAt: 1, updatedAt: 2,
    steps: [{ agent: "assistant", status, task, sessionName: label ?? task, ...(label ? { label } : {}) }],
  };
}
for (const status of ["running", "complete"]) {
  const jobs = [job("one", "Atlas", status), job("two", "Juniper", status), job("three", undefined, status)];
  const snapshot = projectAsyncStatusSnapshot(jobs);
  assert.equal(JSON.stringify(snapshot).includes(task), false);
  for (const [index, expected] of ["Atlas", "Juniper", "assistant"].entries()) {
    const run = snapshot.runs.find(item => item.id === jobs[index].asyncId);
    assert.equal(run.label, expected);
    assert.equal(run.children[0].label, expected);
  }
  const widget = buildWidgetLines(jobs, theme, 120).join("\n");
  for (const expected of ["Atlas", "Juniper", "assistant"]) assert.equal(widget.split(expected).length - 1, 1, widget);
}
const result = { details: { mode: "single", results: [{ agent: "assistant", label: "Atlas", task, exitCode: 0 }] } };
assert.match(renderSubagentSummary(result, {}, theme).render(120).join("\n"), /Atlas/);

process.env.PI_SANDBOX_CONTAINER = "1";
const config = { supervisorChannelDir: "/workspace", runId: "fixture", agent: "assistant", childIndex: 0,
  orchestratorSessionId: "fixture-parent", intercomSessionName: "opaque-target", waitTool: { enabled: false } };
async function runtimeTitle(displayName) {
  const handlers = new Map();
  let savedTitle;
  const pi = { on: (key, fn) => handlers.set(key, fn), events: { on() {} }, getAllTools: () => [], registerTool() {},
    setSessionName: name => { savedTitle = name; } };
  const child = { ...config, displayName, sessionName: displayName ?? task };
  registerRuntime(pi, child);
  await handlers.get("before_agent_start")({ systemPrompt: "" });
  assert.equal(childSupervisorMetadata(child).childTarget, "opaque-target");
  return savedTitle;
}
assert.equal(await runtimeTitle("Atlas"), "Atlas");
assert.equal(await runtimeTitle(undefined), "opaque-target");
console.log("Direct subagent display names passed for launch parameters, both status renderers and saved session titles.");
