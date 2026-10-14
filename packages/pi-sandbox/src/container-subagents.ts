import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequiredChildExtensions, type RequiredChildExtensionRegistration } from "pi-subagents/required-child-extensions";

/** Use standard pi-subagents orchestration with the parent's managed policy. */
export default function containerSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_SANDBOX_CONTAINER !== "1") return;
  // Custom child prompts do not automatically load the parent's APPEND_SYSTEM.md.
  // Root-owned profile guidance must accompany the same required policy extensions.
  pi.on("before_agent_start", async (event) => {
    let systemPrompt = event.systemPrompt;
    for (const name of ["profile.md", "document-tools.md", "security.md"]) {
      const guidance = readFileSync(`/opt/sandbox/${name}`, "utf8").trim();
      if (!systemPrompt.includes(guidance)) systemPrompt += `\n\n${guidance}`;
    }
    return { systemPrompt };
  });
  let registration: RequiredChildExtensionRegistration | undefined;
  pi.on("session_start", async (_event, ctx) => {
    registration?.dispose();
    const sessionId = ctx.sessionManager.getSessionId();
    registration = registerRequiredChildExtensions({
      sessionId,
      requireForAllRunners: true,
      extensions: [
        { id: "container-auto-review", path: "/opt/pi-security/packages/pi-auto-review/src/index.ts" },
        { id: "container-permissions", path: "/opt/pi-security/node_modules/@gotgenes/pi-permission-system/src/index.ts" },
        { id: "container-escalation", path: "/opt/pi-security/packages/pi-reviewed-escalation/index.ts" },
        { id: "container-bash-sandbox", path: "/opt/pi-security/packages/pi-sandbox/src/index.ts" },
        { id: "container-child-policy", path: "/opt/pi-security/packages/pi-sandbox/src/container-subagents.ts" },
      ],
    });
  });
  pi.on("session_shutdown", async () => { registration?.dispose(); registration = undefined; });
}
