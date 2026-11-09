import type { BoundaryApprovalBroker } from "./broker.ts";
import type { BoundaryDecision, BoundaryRequest, BoundaryReviewContext } from "./types.ts";

export const BOUNDARY_BROKER_SERVICE_KEY = Symbol.for("pi-auto-review:boundary-approval-broker");

export type BoundaryApprovalBrokerService = {
  review(request: BoundaryRequest, context: BoundaryReviewContext): Promise<BoundaryDecision>;
  consumeGrant(request: BoundaryRequest, sessionId: string, token: string): boolean;
};

type Registration = { broker: BoundaryApprovalBroker; sessionId: () => string };
type Registry = { registrations: Set<Registration>; service: BoundaryApprovalBrokerService };

function unavailable(): BoundaryDecision {
  return {
    kind: "deny", denialSource: "unavailable", circuitBreakerTripped: false,
    review: { outcome: "deny", riskLevel: "high", userAuthorization: "unknown",
      rationale: "Automatic reviewer is unavailable for this session. No permission granted." },
  };
}

export function publishBoundaryBroker(
  broker: BoundaryApprovalBroker,
  sessionId: () => string,
): () => void {
  const target = globalThis as Record<symbol, unknown>;
  let registry = target[BOUNDARY_BROKER_SERVICE_KEY] as Registry | undefined;
  if (!registry) {
    const registrations = new Set<Registration>();
    const select = (id: string) => {
      // Never fall back to another live chat's instructions or grant store.
      const matches = [...registrations].filter(r => r.sessionId() === id);
      return matches.length === 1 ? matches[0] : undefined;
    };
    registry = { registrations, service: {
      review: async (request, context) => {
        const registration = select(context.sessionId);
        if (!registration) return unavailable();
        const decision = await registration.broker.review(request, context);
        // Disposal/replacement during a model call revokes its eventual result.
        return select(context.sessionId) === registration ? decision : unavailable();
      },
      consumeGrant: (request, id, token) => select(id)?.broker.consumeGrant(request, id, token) ?? false,
    } };
    target[BOUNDARY_BROKER_SERVICE_KEY] = registry;
  }
  const owner = registry;
  const registration = { broker, sessionId };
  owner.registrations.add(registration);
  return () => {
    owner.registrations.delete(registration);
    broker.clear();
    if (!owner.registrations.size && target[BOUNDARY_BROKER_SERVICE_KEY] === owner)
      delete target[BOUNDARY_BROKER_SERVICE_KEY];
  };
}

export function getBoundaryBroker(): BoundaryApprovalBrokerService | undefined {
  return ((globalThis as Record<symbol, unknown>)[BOUNDARY_BROKER_SERVICE_KEY] as Registry | undefined)?.service;
}
