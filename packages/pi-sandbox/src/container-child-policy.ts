import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerRequiredChildExtensions } from 'pi-subagents/required-child-extensions';

export default function childPolicy(pi: ExtensionAPI) {
  const file = '/opt/sandbox/options.json';
  const selected = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const automatic = ['automatic', 'assisted'].includes(selected.approval ?? 'automatic');
  const inner = selected.inner_sandbox !== false;
  const paths = [
    automatic ? '/opt/pi-security/packages/pi-auto-review/src/index.ts' : '/opt/pi-security/packages/pi-auto-review/src/container-approval-mode.ts',
    '/opt/pi-security/node_modules/@gotgenes/pi-permission-system/src/index.ts',
    ...(inner && selected.approval !== 'off' ? ['/opt/pi-security/packages/pi-reviewed-escalation/index.ts'] : []),
    ...(inner ? ['/opt/pi-security/packages/pi-sandbox/src/index.ts'] : []),
    '/opt/pi-security/packages/pi-sandbox/src/container-child-policy.ts',
  ];
  let registration: ReturnType<typeof registerRequiredChildExtensions> | undefined;
  const shared = globalThis as Record<symbol, unknown>;
  const generations = (shared[Symbol.for('pi-subagents:native-approval-generations')] ??= new Map()) as Map<string, string>;
  let owner: { sessionId: string; generation: string } | undefined;
  function release() {
    if (owner && generations.get(owner.sessionId) === owner.generation) generations.delete(owner.sessionId);
    owner = undefined;
    registration?.dispose();
    registration = undefined;
  }
  pi.on('session_start', (_event, ctx) => {
    release();
    const sessionId = ctx.sessionManager.getSessionId();
    const children = shared[Symbol.for('pi-subagents:approval-child-sessions')] as ReadonlyMap<string, unknown> | undefined;
    const isRoot = !children?.has(sessionId);
    if (isRoot && generations.has(sessionId)) throw new Error('Another native approval owner is active for this session.');
    registration = registerRequiredChildExtensions({ sessionId,
      requireForAllRunners: true, extensions: paths.map((path, index) => ({ id: 'container-policy-' + index, path })) });
    if (isRoot) {
      owner = { sessionId, generation: randomUUID() };
      generations.set(sessionId, owner.generation);
    }
  });
  pi.on('session_tree', event => {
    if (!owner || event.oldLeafId === event.newLeafId) return;
    owner.generation = randomUUID();
    generations.set(owner.sessionId, owner.generation);
  });
  pi.on('before_agent_start', event => {
    let systemPrompt = event.systemPrompt;
    for (const name of ['profile.md', 'document-tools.md', 'security.md']) {
      const path = name === 'security.md' && existsSync('/opt/pi-security/config/security.md')
        ? '/opt/pi-security/config/security.md' : '/opt/sandbox/' + name;
      const guidance = readFileSync(path, 'utf8').trim();
      if (!systemPrompt.includes(guidance)) systemPrompt += '\n\n' + guidance;
    }
    systemPrompt += '\nSaved sandbox settings: ' + JSON.stringify(selected) + '. Use only enabled capabilities.';
    return { systemPrompt };
  });
  pi.on('session_shutdown', release);
}
