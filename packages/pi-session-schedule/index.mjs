import { Text } from '@earendil-works/pi-tui';
import { CronScheduler } from 'pi-schedule-prompt/dist/scheduler.js';
import { CronStorage } from 'pi-schedule-prompt/dist/storage.js';
import { createCronTool } from 'pi-schedule-prompt/dist/tool.js';

// Reuse the pinned upstream scheduler without exposing its independent SDK agent.
// Filtering both startup and fire-time reads also protects against persisted jobs
// and jobs changed on disk after their timer was created. Storage.load/save remain
// unfiltered so another session's jobs are preserved by every mutation.
export class SessionStorage extends CronStorage {
  constructor(cwd, sessionId) {
    super(cwd);
    if (!sessionId) throw new Error('Scheduling requires a persistent Pi session ID.');
    this.sessionId = sessionId;
  }
  accepts(job) {
    return job?.session === this.sessionId &&
      ['model', 'extensions', 'skills', 'notify'].every(key => job[key] === undefined);
  }
  getAllJobs() { return super.getAllJobs().filter(job => this.accepts(job)); }
  getJob(id) {
    const job = super.getJob(id);
    return this.accepts(job) ? job : undefined;
  }
  addJob(job) {
    if (!this.accepts(job)) throw new Error('Only current-chat prompts can be scheduled.');
    return super.addJob(job);
  }
  updateJob(id, partial) {
    const current = this.getJob(id);
    if (!current || !this.accepts({ ...current, ...partial }))
      throw new Error('Job is not an inline prompt owned by this chat.');
    return super.updateJob(id, partial);
  }
  removeJob(id) {
    if (!this.getJob(id)) throw new Error('Job is not an inline prompt owned by this chat.');
    return super.removeJob(id);
  }
}

export default function sessionSchedule(pi) {
  let storage;
  let scheduler;
  const upstream = createCronTool(() => storage, () => scheduler, () => 'session');
  const excluded = new Set(['model', 'extensions', 'skills', 'notify']);
  const properties = Object.fromEntries(Object.entries(upstream.parameters.properties)
    .filter(([key]) => !excluded.has(key)));
  const tool = {
    ...upstream,
    description: upstream.description + ' Prompts are injected into this chat using its current model and tools. Jobs belong to this session and run only while it is open. Separate-agent execution is unavailable.',
    parameters: { ...upstream.parameters, properties, additionalProperties: false },
    async execute(id, params, signal, update, ctx) {
      if (!storage || !scheduler) throw new Error('Scheduler session is not initialized.');
      for (const key of Object.keys(params)) {
        if (!(key in properties)) throw new Error(`Unsupported scheduling field: ${key}. Use a prompt in the current chat.`);
      }
      if (params.jobId && !storage.getJob(params.jobId))
        throw new Error('Job is not an inline prompt owned by this chat.');
      return upstream.execute(id, params, signal, update, ctx);
    },
  };
  pi.registerTool(tool);
  pi.registerMessageRenderer('scheduled_prompt', (message, _options, theme) =>
    new Text(theme.fg('accent', `Scheduled prompt: ${message.details?.jobName ?? 'prompt'}`), 0, 0));

  const stop = () => { scheduler?.stop(); scheduler = undefined; storage = undefined; };
  pi.on('session_start', (_event, ctx) => {
    stop();
    storage = new SessionStorage(ctx.cwd, ctx.sessionManager.getSessionId());
    const ignored = storage.load().jobs.filter(job => job.enabled &&
      (!job.session || job.session === storage.sessionId) && !storage.accepts(job));
    if (ignored.length) ctx.ui.notify(`${ignored.length} unsupported scheduled job(s) were left inactive. Recreate them as prompts bound to this chat.`, 'warning');
    scheduler = new CronScheduler(storage, pi, ctx);
    scheduler.start();
  });
  pi.on('session_shutdown', stop);

  // Text commands work over RPC/Pendant as well as Pi's terminal. Full-screen
  // terminal overlays and workdir-wide/background-agent controls are not exposed.
  pi.registerCommand('schedule-prompt', {
    description: 'List this chat’s prompts, or disable/enable/remove JOB_ID, or cleanup',
    handler: async (args, ctx) => {
      const [action = 'list', jobId, extra] = args.trim().split(/\s+/).filter(Boolean);
      if (extra || !['list', 'disable', 'enable', 'remove', 'cleanup'].includes(action)) {
        ctx.ui.notify('Usage: /schedule-prompt [list | disable ID | enable ID | remove ID | cleanup]. Ask the agent to schedule a new prompt.', 'info');
        return;
      }
      try {
        const result = await tool.execute('schedule-command', { action, ...(jobId ? { jobId } : {}) }, undefined, undefined, ctx);
        ctx.ui.notify(result.content.filter(x => x.type === 'text').map(x => x.text).join('\n'), result.isError ? 'error' : 'info');
      } catch (error) { ctx.ui.notify(error.message, 'error'); }
    },
  });
}
