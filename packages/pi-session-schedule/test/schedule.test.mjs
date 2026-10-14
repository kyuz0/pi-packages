import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import schedule, { SessionStorage } from '../index.mjs';
import { CronStorage } from 'pi-schedule-prompt/dist/storage.js';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-session-schedule-'));
  const handlers = {}, prompts = [], tools = {}, commands = {};
  const ctx = { cwd, sessionManager: { getSessionId: () => 'session-a', getEntries: () => [] }, ui: { notify() {} } };
  schedule({ registerTool: x => { tools[x.name] = x; }, registerCommand: (n,x) => { commands[n] = x; },
    registerMessageRenderer() {}, on: (n,f) => { handlers[n] = f; },
    sendMessage() {}, sendUserMessage: (prompt, options) => prompts.push({ prompt, options }),
    events: { emit() {} },
  });
  t.after(() => { handlers.session_shutdown(); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, handlers, prompts, tools, commands, ctx,
    call: params => tools.schedule_prompt.execute('test', params, undefined, undefined, ctx) };
}

test('one-shot prompt is delivered once to the current chat as a follow-up', async t => {
  const f = fixture(t); f.handlers.session_start({}, f.ctx);
  const result = await f.call({ action: 'add', type: 'once', schedule: '+1s', prompt: 'same-chat' });
  assert.equal(result.details.jobs[0].session, 'session-a');
  const deadline = Date.now() + 5000;
  while (!f.prompts.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.deepEqual(f.prompts, [{ prompt: 'same-chat', options: { deliverAs: 'followUp' } }]);
  assert.equal(new CronStorage(f.cwd).getJob(result.details.jobId).enabled, false);
});

test('schema and direct calls exclude independent agent controls', async t => {
  const f = fixture(t); f.handlers.session_start({}, f.ctx);
  for (const key of ['model', 'extensions', 'skills', 'notify', 'session']) {
    assert.equal(f.tools.schedule_prompt.parameters.properties[key], undefined);
    await assert.rejects(f.call({ action: 'add', type: 'once', schedule: '+1s', prompt: 'bad', [key]: 'x' }), /Unsupported/);
  }
  assert.deepEqual(new CronStorage(f.cwd).getAllJobs(), []);
});

test('persisted foreign, unbound and background jobs never run or get modified', async t => {
  const f = fixture(t), raw = new CronStorage(f.cwd);
  const base = { enabled: true, type: 'interval', intervalMs: 20, schedule: '1s', prompt: 'bad', runCount: 0 };
  const jobs = [ { ...base, id: 'foreign', session: 'session-b' }, { ...base, id: 'unbound' },
    { ...base, id: 'background', session: 'session-a', model: 'example' } ];
  raw.save({ version: 1, jobs });
  f.handlers.session_start({}, f.ctx);
  for (const job of jobs) await assert.rejects(f.call({ action: 'enable', jobId: job.id }), /owned by this chat/);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(raw.getAllJobs(), jobs);
});

test('fire-time checks reject a model injected after a timer was created', async t => {
  const f = fixture(t); f.handlers.session_start({}, f.ctx);
  const result = await f.call({ action: 'add', type: 'interval', schedule: '1s', prompt: 'bad' });
  const raw = new CronStorage(f.cwd);
  raw.updateJob(result.details.jobId, { model: 'must-not-run' });
  await new Promise(r => setTimeout(r, 1200));
  assert.deepEqual(f.prompts, []);
});

test('reload keeps only one timer; switching sessions and shutdown stop delivery', async t => {
  const f = fixture(t); f.handlers.session_start({}, f.ctx);
  await f.call({ action: 'add', type: 'interval', schedule: '1s', prompt: 'repeat' });
  f.handlers.session_start({ reason: 'reload' }, f.ctx);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.prompts.length, 1);
  f.ctx.sessionManager.getSessionId = () => 'session-b';
  f.handlers.session_start({ reason: 'switch' }, f.ctx);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(f.prompts.length, 1);
  f.handlers.session_shutdown();
});

test('own job mutations preserve other sessions and reject changing ownership', t => {
  const f = fixture(t), raw = new CronStorage(f.cwd), store = new SessionStorage(f.cwd, 'session-a');
  raw.save({ version: 1, jobs: [{ id: 'other', session: 'session-b' }] });
  store.addJob({ id: 'mine', session: 'session-a' });
  assert.throws(() => store.updateJob('mine', { session: 'session-b' }), /owned by this chat/);
  store.updateJob('mine', { enabled: false });
  store.removeJob('mine');
  assert.deepEqual(raw.getAllJobs(), [{ id: 'other', session: 'session-b' }]);
});
