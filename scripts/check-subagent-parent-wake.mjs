import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const directory = resolve(process.argv[2] ?? "node_modules/pi-subagents");
const { createParentWake, PARENT_WAKE_TEXT } = await import(pathToFileURL(join(directory, "src/shared/parent-wake.js")));
const { trackReviewBranch } = await createJiti(import.meta.url).import(
  new URL("../packages/pi-auto-review/src/review/retained-context.ts", import.meta.url).href,
);
const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-parent-wake-"));
const settingsManager = SettingsManager.inMemory();
const sessionManager = SessionManager.inMemory(cwd);
const hookTriggers = [];
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "fixture",
  baseUrl: "http://fixture.invalid", input: ["text"], reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 };
let session;
try {
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => { pi.on("before_agent_start", event => { hookTriggers.push(event.messageType); }); }] });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, sessionManager, settingsManager, resourceLoader, model, tools: [] }));
  await session.bindExtensions({});
  let requests = 0;
  session.agent.streamFunction = (_model, context) => {
    requests++;
    assert.ok(JSON.stringify(context.messages).includes(PARENT_WAKE_TEXT));
    const stream = createAssistantMessageEventStream();
    const response = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
      content: [{ type: "text", text: "Fixture completed." }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: "done", reason: "stop", message: response });
    stream.end(response);
    return stream;
  };
  function human(text) {
    sessionManager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  }
  human("Synthetic authorization scope.");
  const isCurrent = trackReviewBranch(sessionManager, [], true);
  const deliveries = [];
  const wake = createParentWake({ sendMessage(message, options) {
    deliveries.push(session.sendCustomMessage(message, options));
  } });
  wake.bindSession({ sessionManager, isIdle: () => true });
  const update = { customType: "subagent-notify", content: "Fixture child finished.", display: true };
  assert.equal(wake.sendMessage(update, { triggerTurn: true }), true);
  // Two completions can arrive before the first wake starts.
  assert.equal(wake.sendMessage(update, { triggerTurn: true }), true);
  await Promise.all(deliveries);
  const wakes = sessionManager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === "subagent-wake");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].content, PARENT_WAKE_TEXT);
  assert.equal(wakes[0].display, false);
  assert.deepEqual(hookTriggers, ["custom"]);
  assert.equal(requests, 1);
  assert.ok(sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop"));
  wake.agentStarted();
  wake.userAborted();
  assert.equal(wake.sendMessage(update, { triggerTurn: true }), true);
  await Promise.all(deliveries);
  assert.equal(requests, 1);
  assert.equal(isCurrent(), true);
  human(PARENT_WAKE_TEXT);
  assert.equal(isCurrent(), false);
  console.log("A background completion started one Pi turn, ran its startup hook and preserved the origin of identical human and extension text.");
} finally {
  session?.dispose();
  await rm(cwd, { recursive: true, force: true });
}
