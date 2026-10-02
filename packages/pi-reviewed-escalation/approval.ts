import { randomUUID } from "node:crypto";
import type { BoundaryApprovalBrokerService, BoundaryRequest } from "@erichll/pi-auto-review/broker";

export type EscalationInput = {
  command: string;
  justification: string;
  cwd: string;
  toolCallId: string;
  sessionId: string;
  scopeKey: string;
  timeout?: number;
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
    confirm?: (request: BoundaryRequest, rationale: string) => Promise<boolean>;
  },
): Promise<EscalationApproval> {
  if (options.signal?.aborted) return { allowed: false, rationale: "Escalation cancelled." };
  if (!input.command.trim() || !input.justification.trim()) {
    return { allowed: false, rationale: "An exact command and escalation justification are required." };
  }
  const broker = options.broker;
  if (!broker) return { allowed: false, rationale: "The automatic approval broker is unavailable; host execution is disabled." };
  const request: BoundaryRequest = {
    id: `pi-reviewed-escalation-${randomUUID()}`,
    source: "sandbox-runtime",
    surface: "host-ipc",
    operation: "execute-host",
    toolName: "bash_escalate",
    toolCallId: input.toolCallId,
    command: input.command,
    cwd: input.cwd,
    matchedPolicy: { decision: "ask", rule: "explicit-sandbox-escalation" },
    toolInputPreview: JSON.stringify({
      execution: "This exact command will run on the host OUTSIDE the OS sandbox, with the user's filesystem, credentials, network and Unix-socket access. Permission for ordinary sandboxed Bash does not authorize this host execution.",
      justification: input.justification,
      timeoutSeconds: input.timeout ?? null,
    }),
  };
  const decision = await broker.review(request, {
    sessionId: input.sessionId,
    scopeKey: input.scopeKey,
    issueGrant: true,
  });
  if (options.signal?.aborted) return { allowed: false, rationale: "Escalation cancelled." };
  if (decision.kind === "deny") {
    const recovery = decision.recoveryCommand ? ` ${decision.recoveryCommand} can authorize an exact retry in supported terminal sessions.` : "";
    return { allowed: false, rationale: decision.review.rationale + recovery };
  }
  if (decision.kind === "defer") {
    const approved = options.confirm && await options.confirm(request, decision.review.rationale);
    if (options.signal?.aborted || !approved) return { allowed: false, rationale: decision.review.rationale };
    return { allowed: true, rationale: decision.review.rationale, approvedBy: "human" };
  }
  if (!decision.grant || !broker.consumeGrant(request, input.sessionId, decision.grant.token)) {
    return { allowed: false, rationale: "The exact one-shot escalation grant is missing, invalid, or expired." };
  }
  return { allowed: true, rationale: decision.review.rationale, approvedBy: "reviewer" };
}
