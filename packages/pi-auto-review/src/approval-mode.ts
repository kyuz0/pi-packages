import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";

const labels = {
  automatic: "Automatic (non-interactive)",
  assisted: "Automatic (interactive)",
  manual: "Manual (ask me)",
  off: "No approval prompts (YOLO)",
};

export function notifyApprovalMode(
  event: SessionStartEvent,
  ctx: ExtensionContext,
  mode: keyof typeof labels,
): void {
  if (!ctx.hasUI || event.reason === "reload" || process.env.PI_SUBAGENT_CHILD === "1"
    || process.env.PI_SANDBOX_SUBAGENT_DEPTH) return;

  const reviewerHelp = mode === "automatic" || mode === "assisted"
    ? " Use /auto-review-settings to change the reviewer model or thinking effort."
    : "";
  ctx.ui.notify(`Approval mode is ${labels[mode]}.${reviewerHelp}`, "info");
}
