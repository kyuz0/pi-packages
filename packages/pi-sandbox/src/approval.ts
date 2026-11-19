import type {
  BoundaryApprovalBrokerService,
  BoundaryRequest,
  ReviewerConfirmation,
} from "@erichll/pi-auto-review/broker";
import { managedChild, requestChildApproval } from "@erichll/pi-auto-review/managed-child";
import { sandboxTrapToBoundaryRequest } from "@erichll/pi-auto-review/sandbox";
import type { SandboxApprovalTrap } from "./traps.ts";
import type { HostIPCTrigger } from "./host-ipc.ts";
import { randomUUID } from "node:crypto";
export type NetworkEndpoint = {
  hostname: string;
  port: number;
  protocol: "http" | "https" | "tcp";
};

export type HumanApproval = (
  request: BoundaryRequest,
  reason?: string,
  signal?: AbortSignal,
  confirmation?: ReviewerConfirmation,
) => Promise<"allow-once" | "deny">;

export type TrapApprovalContext = {
  broker?: BoundaryApprovalBrokerService;
  command: string;
  cwd: string;
  sessionId: string;
  scopeKey: string;
  turn?: number;
  agentName?: string;
  signal?: AbortSignal;
  humanApproval?: HumanApproval;
  humanFallback?: boolean;
  isCurrent?: () => boolean;
};

export type TrapApprovalResult = {
  action: "allow" | "deny";
  source:
    | "hard-deny"
    | "reviewer"
    | "human"
    | "unavailable"
    | "invalid-grant";
  reason?: string;
};

export async function approveDomainEndpoint(
  endpoint: NetworkEndpoint,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  const child = process.env.PI_SANDBOX_CONTAINER === "1" ? managedChild(context.sessionId) : undefined;
  if (child) {
    const decision = await requestChildApproval(child, {
      sessionId: context.sessionId,
      command: context.command,
      cwd: context.cwd,
      turn: context.turn,
      toolCallId: randomUUID(),
      justification: "Allow a connection requested by the sandboxed command.",
      endpoint,
    }, context.signal);
    if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) {
      return { action: "deny", source: "unavailable", reason: "The delegated connection was cancelled." };
    }
    return decision.allowed ? { action: "allow", source: decision.approvedBy ?? "reviewer", reason: decision.rationale }
      : { action: "deny", source: "reviewer", reason: decision.rationale };
  }
  const request: BoundaryRequest = {
    id: `sandbox-runtime-network-${randomUUID()}`,
    source: "sandbox-runtime",
    surface: "network",
    operation: "connect",
    cwd: context.cwd,
    command: context.command,
    destination: `${endpoint.hostname}:${endpoint.port}`,
    destinationHost: endpoint.hostname,
    destinationPort: endpoint.port,
    destinationProtocol: endpoint.protocol,
    agentName: context.agentName,
    matchedPolicy: {
      decision: "ask",
      rule: "network-unmatched",
    },
  };
  return approveBoundaryRequest(request, context);
}

export async function approveHostIPCExecution(
  trigger: HostIPCTrigger,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  const request: BoundaryRequest = {
    id: `sandbox-runtime-host-ipc-${randomUUID()}`,
    source: "sandbox-runtime",
    surface: "host-ipc",
    operation: "execute-host",
    cwd: context.cwd,
    command: context.command,
    matchedPolicy: {
      decision: "ask",
      rule:
        trigger.reason === "preflight-prefix"
          ? `preflight-prefix:${trigger.rule}`
          : "unix-socket-eperm",
    },
    toolInputPreview:
      trigger.reason === "unix-socket-eperm"
        ? "The sandboxed attempt failed and may already have had partial side effects."
        : "A configured prefix requested approval before sandbox execution.",
    agentName: context.agentName,
  };
  return approveBoundaryRequest(request, context);
}

async function askHuman(
  request: BoundaryRequest,
  context: TrapApprovalContext,
  reason?: string,
  confirmation?: ReviewerConfirmation,
): Promise<TrapApprovalResult> {
  if (!context.humanApproval || context.signal?.aborted) {
    return { action: "deny", source: "unavailable", reason };
  }
  if (confirmation && !confirmation.isCurrent()) {
    return { action: "deny", source: "unavailable", reason: "The request changed. No permission was granted." };
  }
  const choice = await context.humanApproval(request, reason, context.signal, confirmation);
  if (context.signal?.aborted || (confirmation && !confirmation.isCurrent())) {
    return { action: "deny", source: "unavailable", reason: "The request changed or was cancelled. No permission was granted." };
  }
  return choice === "allow-once"
    ? { action: "allow", source: "human", reason }
    : { action: "deny", source: "human", reason };
}

async function approveBoundaryRequest(
  request: BoundaryRequest,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  if (!context.broker && !(context.humanFallback ?? process.env.SANDBOX_APPROVAL_MODE === "manual")) return { action: "deny", source: "unavailable", reason: "Automatic reviewer is unavailable. No permission granted; retry after the reviewer is available." };
  if (!context.broker) {
    return askHuman(request, context, "pi-auto-review broker is unavailable");
  }

  let decision;
  try {
    decision = await context.broker.review(request, {
      sessionId: context.sessionId,
      scopeKey: context.scopeKey,
      isCurrent: context.isCurrent,
      signal: context.signal,
      issueGrant: true,
    });
  } catch (error) {
    return {
      action: "deny",
      source: "unavailable",
      reason: `Broker failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (decision.kind === "deny") {
    const recoveryCommand =
      decision.recoveryCommand ?? "/auto-review-approve";
    const recovery =
      recoveryCommand === false
        ? (decision.denialSource === "hard-deny" ? " This local safety denial cannot be overridden." : "")
        : ` Use ${recoveryCommand} for one exact retry.`;
    return {
      action: "deny",
      source:
        decision.denialSource === "hard-deny" ? "hard-deny" : "reviewer",
      reason: `${decision.review.rationale}${recovery}`,
    };
  }
  if (decision.kind === "defer") {
    return askHuman(request, context, decision.review.rationale, decision.confirmation);
  }
  if (
    !decision.grant ||
    !context.broker.consumeGrant(
      request,
      context.sessionId,
      decision.grant.token,
    )
  ) {
    return {
      action: "deny",
      source: "invalid-grant",
      reason: "The exact one-shot grant is missing, invalid, or expired.",
    };
  }
  return {
    action: "allow",
    source: "reviewer",
    reason: decision.review.rationale,
  };
}

export async function approveSandboxTrap(
  trap: SandboxApprovalTrap,
  context: TrapApprovalContext,
): Promise<TrapApprovalResult> {
  const request = sandboxTrapToBoundaryRequest(trap, {
    command: context.command,
    cwd: context.cwd,
    agentName: context.agentName,
  });

  if (trap.kind === "network") {
    return {
      action: "deny",
      source: "hard-deny",
      reason:
        "Direct network access is disabled; use the authenticated domain proxy.",
    };
  }
  if (trap.kind === "filesystem" && trap.reason === "deny_match") {
    return {
      action: "deny",
      source: "hard-deny",
      reason: "The path matches an explicit sandbox deny rule.",
    };
  }
  return approveBoundaryRequest(request, context);
}
