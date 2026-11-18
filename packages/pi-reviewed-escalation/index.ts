import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getBoundaryBroker } from "@erichll/pi-auto-review/broker";
import { Type } from "typebox";
import { approveEscalation } from "./approval.ts";
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
      const input = { command, justification, timeout, cwd, toolCallId: id, sessionId, scopeKey: `${sessionId}:turn:${requestTurn}` };
      const decision = await approveEscalation(input, {
        broker: getBoundaryBroker(),
        signal,
        isCurrent: () => !signal?.aborted && turn === requestTurn && ctx.sessionManager.getSessionId() === sessionId,
        confirm: ctx.hasUI ? async (request, rationale, confirmation) => {
          const reason = confirmation
            ? `\n${confirmation.outcome === "deny" ? "The reviewer rejected this command." : "The reviewer left the decision to you."}\n${rationale}`
            : mode === "manual" ? "" : `\nReviewer: ${rationale}`;
          const choice = await ctx.ui.select(
            `Run this exact command OUTSIDE the sandbox?\nWorking directory: ${request.cwd}\nCommand: ${request.command}\nJustification: ${justification}${reason}\nThis uses the ${boundary} filesystem, credentials, network and sockets.`,
            ["Allow this exact command once", "Deny"],
            { signal },
          );
          if (choice !== "Allow this exact command once" || signal?.aborted) return false;
          if (!confirmation?.critical) return true;
          if (!confirmation.isCurrent()) return false;
          return await ctx.ui.input("The reviewer rated this command critical. Type APPROVE to run it once.", undefined, { signal }) === "APPROVE";
        } : undefined,
      });
      pi.appendEntry("pi-reviewed-escalation", { ...input, ...decision });
      if (!decision.allowed || signal?.aborted) {
        return { isError: true, content: [{ type: "text", text: `${boundary} execution denied: ${signal?.aborted ? "Escalation cancelled." : decision.rationale}` }], details: { escalated: false, ...decision } };
      }
      const shellPath = SettingsManager.create(cwd).getShellPath();
      const tool = createBashToolDefinition(cwd, { operations: createLocalBashOperations({ shellPath }) });
      const result = await tool.execute(id, { command, timeout }, signal, onUpdate, ctx);
      return { ...result, details: { ...result.details, escalated: true, approval: decision.approvedBy, approvalRationale: decision.rationale } };
    },
  });
}
