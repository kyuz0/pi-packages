import { randomUUID } from "node:crypto";
import type { ManagedEndpoint } from "@erichll/pi-auto-review/managed-child";
import type { BoundaryApprovalBrokerService, BoundaryRequest, ReviewerConfirmation } from "@erichll/pi-auto-review/broker";

export type EscalationInput = {
  command: string;
  justification: string;
  cwd: string;
  toolCallId: string;
  sessionId: string;
  scopeKey: string;
  timeout?: number;
  turn?: number;
  endpoint?: ManagedEndpoint;
  requesterSessionId?: string;
  agentName?: string;
};

export type EscalationApproval = {
  allowed: boolean;
  rationale: string;
  approvedBy?: "reviewer" | "human";
};

export async function approveEscalation(
  input: EscalationInput,
  options: {
    broker?: BoundaryApprovalBrokerService;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    confirm?: (request: BoundaryRequest, rationale: string, confirmation: ReviewerConfirmation | undefined,
      isCurrent: () => boolean) => Promise<boolean>;
  },
): Promise<EscalationApproval> {
  if (options.signal?.aborted) return { allowed: false, rationale: "Escalation cancelled." };
  if (!input.command.trim() || !input.justification.trim()) {
    return { allowed: false, rationale: "An exact command and escalation justification are required." };
  }
  const broker = options.broker;
  if (!broker) return { allowed: false, rationale: "The automatic approval broker is unavailable; host execution is disabled." };
  const request: BoundaryRequest = {
    id: `pi-reviewed-${input.endpoint ? "network" : "escalation"}-${randomUUID()}`,
    source: "sandbox-runtime",
    ...(input.endpoint ? {
      surface: "network",
      operation: "connect",
      toolName: "bash",
      destination: `${input.endpoint.hostname}:${input.endpoint.port}`,
      destinationHost: input.endpoint.hostname,
      destinationPort: input.endpoint.port,
      destinationProtocol: input.endpoint.protocol,
      matchedPolicy: { decision: "ask" as const, rule: "network-unmatched" },
      toolInputPreview: "Allow one connection through the inner sandbox proxy. The outer container network policy still applies.",
    } : {
      surface: "host-ipc",
      operation: "execute-host",
      toolName: "bash_escalate",
      matchedPolicy: { decision: "ask" as const, rule: "explicit-sandbox-escalation" },
      toolInputPreview: JSON.stringify({
        execution: process.env.PI_SANDBOX_CONTAINER === "1"
          ? "This exact command runs inside the outer devcontainer, outside the inner OS sandbox, with the container user filesystem, credentials, network and sockets. It never runs on the physical host. Ordinary sandboxed Bash permission does not authorize this escalation."
          : "This exact command will run on the host OUTSIDE the OS sandbox, with the user's filesystem, credentials, network and Unix-socket access. Permission for ordinary sandboxed Bash does not authorize this host execution.",
        justification: input.justification,
        timeoutSeconds: input.timeout ?? null,
      }),
    }),
    toolCallId: input.toolCallId,
    command: input.command,
    cwd: input.cwd,
    requesterSessionId: input.requesterSessionId,
    agentName: input.agentName,
  };
  const decision = await broker.review(request, {
    sessionId: input.sessionId,
    scopeKey: input.scopeKey,
    isCurrent: options.isCurrent,
    signal: options.signal,
    issueGrant: true,
    ...(input.requesterSessionId ? { delegated: true as const } : {}),
  });
  if (options.signal?.aborted) return { allowed: false, rationale: "Escalation cancelled." };
  if (decision.kind === "deny") {
    const recovery = decision.recoveryCommand ? ` ${decision.recoveryCommand} can authorize an exact retry in supported terminal sessions.` : "";
    return { allowed: false, rationale: decision.review.rationale + recovery };
  }
  if (decision.kind === "defer") {
    const confirmation = decision.confirmation;
    const isCurrent = () => !options.signal?.aborted && (options.isCurrent?.() ?? true) &&
      (input.requesterSessionId ? decision.isCurrent?.() === true : true) &&
      (confirmation?.isCurrent() ?? true);
    if (!isCurrent()) return { allowed: false, rationale: "The request changed. No permission was granted." };
    const approved = options.confirm && await options.confirm(request, decision.review.rationale, confirmation, isCurrent);
    if (!isCurrent()) return { allowed: false, rationale: "The request changed or was cancelled. No permission was granted." };
    if (!approved) {
      return { allowed: false, rationale: decision.review.rationale };
    }
    return { allowed: true, rationale: decision.review.rationale, approvedBy: "human" };
  }
  if (!(options.isCurrent?.() ?? true) || !decision.grant || !broker.consumeGrant(request, input.sessionId, decision.grant.token)) {
    return { allowed: false, rationale: "The exact one-shot escalation grant is missing, invalid, or expired." };
  }
  return { allowed: true, rationale: decision.review.rationale, approvedBy: "reviewer" };
}
