import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveReviewerMeta, reviewerReasoning, reviewerReasoningLevels } from "./provider.ts";
import type { Config, ReasoningLevel } from "./types.ts";

type ReviewerSettings = Pick<Config, "model" | "reasoning">;

function effortLabel(effort: ReasoningLevel): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

async function describe(ctx: ExtensionCommandContext, config: Readonly<Config>): Promise<string> {
  const { model } = await resolveReviewerMeta(ctx, config);
  const modelLabel = `${model.provider}/${model.id}`;
  const active = reviewerReasoning(model, config.reasoning);
  const effort = active === config.reasoning ? effortLabel(active)
    : `${effortLabel(active)} (${effortLabel(config.reasoning)} requested)`;
  return `${config.model === "current" ? `Current chat model (${modelLabel})` : modelLabel} · ${effort}`;
}

export function registerReviewerSettings(
  pi: ExtensionAPI,
  read: () => Readonly<Config> | undefined,
  change: (settings: Partial<ReviewerSettings>) => void,
): void {
  pi.registerCommand("auto-review-settings", {
    description: "View or change the reviewer model and thinking effort for this chat",
    handler: async (_args, ctx) => {
      const config = read();
      if (!config || !ctx.hasUI || !ctx.isIdle()) {
        ctx.ui.notify("Open reviewer settings from an idle chat.", "info");
        return;
      }
      const action = await ctx.ui.select(
        await describe(ctx, config).catch(() => `Reviewer model unavailable · ${config.model}`),
        ["Reviewer model", "Thinking effort"],
      );
      let settings: Partial<ReviewerSettings>;
      if (action === "Reviewer model") {
        const current = "Current chat model";
        const models = [...new Set(ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`))];
        const selected = await ctx.ui.select("Reviewer model", [current, ...models]);
        if (!selected) return;
        settings = { model: selected === current ? "current" : selected };
      } else if (action === "Thinking effort") {
        let levels: ReasoningLevel[];
        try {
          const { model } = await resolveReviewerMeta(ctx, config);
          levels = reviewerReasoningLevels(model);
        } catch {
          ctx.ui.notify("Choose an available reviewer model before changing thinking effort.", "warning");
          return;
        }
        const selected = await ctx.ui.select("Thinking effort", levels.map(effortLabel));
        const reasoning = levels.find(level => effortLabel(level) === selected);
        if (!reasoning) return;
        settings = { reasoning };
      } else {
        return;
      }
      const next = { ...config, ...settings };
      let description: string;
      try {
        description = await describe(ctx, next);
      } catch {
        ctx.ui.notify("Select an available reviewer model.", "warning");
        return;
      }
      if (read() !== config || !ctx.isIdle()) {
        ctx.ui.notify("The chat changed while reviewer settings were open. Open them again to retry.", "warning");
        return;
      }
      change(settings);
      ctx.ui.notify(`Reviewer updated for this chat. ${description}`, "info");
    },
  });
}
