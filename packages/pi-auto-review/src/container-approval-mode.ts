// Manual/off modes retain the boundary broker contract without a model call.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { publishBoundaryBroker, type BoundaryDecision } from './broker/index.ts';
import { notifyApprovalMode } from './approval-mode.ts';
import { trackReviewBranch } from './review/retained-context.ts';

export default function approvalMode(pi: ExtensionAPI) {
  const mode = process.env.SANDBOX_APPROVAL_MODE;
  if (mode !== 'manual' && mode !== 'off') throw new Error('Invalid approval mode');
  const service = {
    async review(): Promise<BoundaryDecision> {
      const rationale = mode === 'manual' ? 'Human approval is required for this boundary request.'
        : 'Approval prompts are disabled; access beyond the inner sandbox is refused.';
      const review = { outcome: mode === 'manual' ? 'defer' as const : 'deny' as const, riskLevel: 'medium' as const, userAuthorization: 'unknown' as const, rationale };
      return mode === 'manual' ? { kind: 'defer', review }
        : { kind: 'deny', review, circuitBreakerTripped: false, recoveryCommand: false };
    },
    consumeGrant() { return false; },
    clear() {},
  };
  let dispose: (() => void) | undefined;
  pi.on('session_start', (event, ctx) => {
    dispose?.();
    const sessionId = ctx.sessionManager.getSessionId();
    dispose = publishBoundaryBroker(service, () => sessionId, (review) => {
      if (!review.delegated) return undefined;
      return trackReviewBranch(ctx.sessionManager, [], true);
    });
    notifyApprovalMode(event, ctx, mode);
  });
  pi.on('session_shutdown', () => { dispose?.(); dispose = undefined; });
}
