import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getBoundaryBroker } from "@erichll/pi-auto-review/broker";
import { Type } from "typebox";
import { approveEscalation, type EscalationInput } from "./approval.ts";
import { managedChild, requestChildApproval, serveChildApprovals } from "@erichll/pi-auto-review/managed-child";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

export default function reviewedEscalation(pi: ExtensionAPI): void {
  // On a standalone host, contained workers cannot escalate past their outer
  // sandbox. Managed devcontainer children share the parent execution boundary.
  if (process.env.PI_SANDBOX_CONTAINER !== "1" &&
      (process.env.PI_SANDBOX_SUBAGENT_DEPTH || process.env.PI_SUBAGENT_CHILD === "1")) return;
  const container = process.env.PI_SANDBOX_CONTAINER === "1";
  const boundary = container ? "outer container" : "host";
  const mode = container ? process.env.SANDBOX_APPROVAL_MODE : undefined;
  let turn = 0;
  pi.on("turn_start", async () => { turn += 1; });
  let dispose: (() => void) | undefined;
  let ownerGeneration = 0;
  let uiQueue = Promise.resolve();
  function decide(input: EscalationInput, ctx: ExtensionContext, isCurrent: () => boolean, signal?: AbortSignal) {
    return approveEscalation(input, {
      broker: getBoundaryBroker(),
      signal,
      isCurrent,
      confirm: ctx.hasUI ? (request, rationale, confirmation, stillCurrent) => {
        const promptSignal = confirmation?.signal
          ? AbortSignal.any(signal ? [signal, confirmation.signal] : [confirmation.signal])
          : signal;
        const answer = uiQueue.then(async () => {
          if (!stillCurrent() || promptSignal?.aborted) return false;
          const title = input.endpoint ? `Allow this connection to ${request.destination}?`
            : container ? "Run this exact command outside the inner sandbox?"
              : "Run this exact command outside the sandbox?";
          const sections = [title, `Working directory: ${request.cwd}`];
          if (input.requesterSessionId) {
            sections.push(`Subagent: ${input.agentName || "worker"} (${input.requesterSessionId.slice(0, 8)})`);
          }
          if (confirmation) {
            const verdict = confirmation.outcome === "deny"
              ? "The reviewer rejected this command."
              : "The reviewer left the decision to you.";
            sections.push(`${verdict}\n${rationale}`);
          } else if (mode !== "manual") {
            sections.push(`Reviewer\n${rationale}`);
          }
          sections.push(
            `Command\n${request.command}`,
            `Justification\n${input.justification}`,
            input.endpoint
              ? "Execution scope\nThe outer container network policy still applies."
              : `Execution scope\nThis uses the ${boundary} filesystem, credentials, network and sockets.`,
          );
          const allow = input.endpoint ? "Allow this exact operation once" : "Allow this exact command once";
          const choice = await ctx.ui.select(
            sections.join("\n\n"),
            [allow, "Deny"],
            { signal: promptSignal },
          );
          if (choice !== allow || !stillCurrent() || promptSignal?.aborted) return false;
          if (!confirmation?.critical) return true;
          return await ctx.ui.input("The reviewer rated this command critical. Type APPROVE to run it once.",
            undefined, { signal: promptSignal }) === "APPROVE" && stillCurrent();
        });
        uiQueue = answer.then(() => {}, () => {});
        return answer;
      } : undefined,
    });
  }

  if (container && process.env.SANDBOX_SUBAGENTS === "1") {
    function stopServing() {
      ownerGeneration += 1;
      dispose?.();
      dispose = undefined;
    }
    async function restoreServing(ctx: ExtensionContext) {
      stopServing();
      const generation = ownerGeneration;
      const sessionId = ctx.sessionManager.getSessionId();
      if (managedChild(sessionId)) return;
      const close = await serveChildApprovals(sessionId, (input, signal) => {
        const agentName = input.agent?.replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 80);
        return decide({
          command: input.command, cwd: input.cwd, justification: input.justification, timeout: input.timeout, endpoint: input.endpoint,
          toolCallId: input.toolCallId, requesterSessionId: input.childSessionId, agentName,
          sessionId, scopeKey: `delegated:${input.childSessionId}:turn:${input.turn}`,
        }, ctx, () => !signal.aborted && ownerGeneration === generation &&
          ctx.sessionManager.getSessionId() === sessionId, signal);
      });
      if (ownerGeneration === generation) dispose = close;
      else close();
    }
    pi.on("session_start", (_event, ctx) => restoreServing(ctx));
    pi.on("session_tree", (_event, ctx) => restoreServing(ctx));
    pi.on("session_shutdown", stopServing);
  }

  pi.registerTool({
    name: "bash_escalate",
    label: `Bash escalation (reviewed ${boundary} execution)`,
    description: (container ? "The outer devcontainer is the limit: this tool never executes on the physical host. " : "") + "Run one justified shell command OUTSIDE the OS sandbox, only after approval. Use ordinary bash for routine project work. Use this tool when required filesystem, SSH, network or Unix-socket access is unavailable in the sandbox, including known restrictions that make a sandbox attempt pointless. Supply the exact command and explain how the outside access serves the user's request. Never use escalation to work around a reviewer denial or an explicit credential/security policy deny. A model denial does not execute the command. Execution does not confer root privileges.",
    ...(mode === "assisted" ? {
      description: "Ask to run one exact command outside the inner sandbox, inside the development container. The reviewer checks the command first. Pi may ask the user if the reviewer rejects it or leaves the decision open. Supply the exact command and why it needs outside access. Use ordinary Bash for routine work. Explicit sandbox and permission blocks still apply.",
    } : {}),
    parameters: Type.Object({
      command: Type.String({ description: "Exact shell command to review and execute once." }),
      justification: Type.String({ description: `Why ${boundary} access is required and how it serves the user's request.` }),
      timeout: Type.Optional(Type.Number({ minimum: 1, description: "Command timeout in seconds, after approval." })),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const command = params.command;
      const justification = params.justification;
      const timeout = params.timeout;
      const cwd = ctx.cwd;
      const installation = realpathSync(dirname(fileURLToPath(import.meta.url)));
      const location = relative(realpathSync(cwd), installation);
      if (location === "" || (!location.startsWith("..") && !isAbsolute(location))) {
        throw new Error("Refusing host escalation from extension code inside the agent's writable workspace.");
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const requestTurn = turn;
      const input = { command, justification, timeout, cwd, toolCallId: id, sessionId, turn: requestTurn, scopeKey: `${sessionId}:turn:${requestTurn}` };
      const isCurrent = () => !signal?.aborted && turn === requestTurn && ctx.sessionManager.getSessionId() === sessionId;
      const child = container ? managedChild(sessionId) : undefined;
      const decision = child
        ? await requestChildApproval(child, input, signal)
        : await decide(input, ctx, isCurrent, signal);
      pi.appendEntry("pi-reviewed-escalation", { ...input, ...decision });
      if (!decision.allowed || !isCurrent()) {
        return { isError: true, content: [{ type: "text", text: `${boundary} execution denied: ${!isCurrent() ? "Escalation cancelled or the request changed." : decision.rationale}` }], details: { escalated: false, ...decision } };
      }
      const shellPath = SettingsManager.create(cwd).getShellPath();
      const tool = createBashToolDefinition(cwd, { operations: createLocalBashOperations({ shellPath }) });
      const result = await tool.execute(id, { command, timeout }, signal, onUpdate, ctx);
      return { ...result, details: { ...result.details, escalated: true, approval: decision.approvedBy, approvalRationale: decision.rationale } };
    },
  });
}
