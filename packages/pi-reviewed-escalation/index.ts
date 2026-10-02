import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getBoundaryBroker } from "@erichll/pi-auto-review/broker";
import { Type } from "typebox";
import { approveEscalation } from "./approval.ts";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

export default function reviewedEscalation(pi: ExtensionAPI): void {
  // Worker processes remain contained by their outer sandbox.
  if (process.env.PI_SANDBOX_SUBAGENT_DEPTH || process.env.PI_SUBAGENT_CHILD === "1") return;
  let turn = 0;
  pi.on("turn_start", async () => { turn += 1; });
  pi.registerTool({
    name: "bash_escalate",
    label: "Bash escalation (reviewed host execution)",
    description: "Run one justified shell command OUTSIDE the OS sandbox, only after approval by the current-model reviewer or explicit human confirmation of a deferral. Use ordinary bash for routine project work. Use this tool when required filesystem, SSH, network or Unix-socket access is unavailable in the sandbox, including known restrictions that make a sandbox attempt pointless. Supply the exact command and explain how the outside access serves the user's request. Never use escalation to work around a reviewer denial or an explicit credential/security policy deny. A model denial does not execute the command. Execution has the user's host access; it does not confer root privileges.",
    parameters: Type.Object({
      command: Type.String({ description: "Exact shell command to review and execute once." }),
      justification: Type.String({ description: "Why host access is required and how it serves the user's request." }),
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
      const input = { command, justification, timeout, cwd, toolCallId: id, sessionId, scopeKey: `${sessionId}:turn:${turn}` };
      const decision = await approveEscalation(input, {
        broker: getBoundaryBroker(),
        signal,
        confirm: ctx.hasUI ? async (request, rationale) => {
          const choice = await ctx.ui.select(
            `Run this exact command OUTSIDE the sandbox?\nWorking directory: ${request.cwd}\nCommand: ${request.command}\nJustification: ${justification}\nReviewer: ${rationale}\nThis uses your host filesystem, credentials, network and sockets.`,
            ["Allow this exact command once", "Deny"],
            { signal },
          );
          return choice === "Allow this exact command once";
        } : undefined,
      });
      pi.appendEntry("pi-reviewed-escalation", { ...input, ...decision });
      if (!decision.allowed || signal?.aborted) {
        return { isError: true, content: [{ type: "text", text: `Host execution denied: ${signal?.aborted ? "Escalation cancelled." : decision.rationale}` }], details: { escalated: false, ...decision } };
      }
      const shellPath = SettingsManager.create(cwd).getShellPath();
      const tool = createBashToolDefinition(cwd, { operations: createLocalBashOperations({ shellPath }) });
      const result = await tool.execute(id, { command, timeout }, signal, onUpdate, ctx);
      return { ...result, details: { ...result.details, escalated: true, approval: decision.approvedBy, approvalRationale: decision.rationale } };
    },
  });
}
