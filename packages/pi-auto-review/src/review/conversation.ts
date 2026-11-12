import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundaryRequest } from "../broker/index.ts";
import { parseDecision, type TranscriptResult } from "../policy.ts";
import { preflightPart, textFromAssistant, conversationAction } from "./input.ts";
import { reviewerConversations, digest, providerIdentity } from "./conversation-store.ts";
import { retainedSnapshot } from "./retained-context.ts";
import { FORMAT_RETRY_INSTRUCTION } from "./consts.ts";
import { conversationPrompt } from "./prompts.ts";
import { modelCall, observedUsage, resolveApiKeyAndHeaders, reviewerSessionId, abortableOperation, abortableDelay, classifyProviderFailure, normalizedStopReason, isRetryableError, isFormatError, parseErrorClass, retryDelayMs, type ProviderAttemptMetadata, type ReviewerResolver } from "./provider.ts";
import type { Config, ReviewPreflight, ReviewResult, ReviewExecutionSummary, ReviewerTelemetryEvent, ReviewErrorClass, ReviewAttemptStatus } from "./types.ts";

export { conversationPrompt } from "./prompts.ts";

type Options = { ctx: ExtensionContext; config: Config; request: BoundaryRequest; transcript: TranscriptResult; preflight: ReviewPreflight; sharedContext: string; started: number; resolve: ReviewerResolver; observe?: (event: ReviewerTelemetryEvent) => void };
export async function completeConversation(o: Options): Promise<ReviewResult> {
  const { ctx, config, request, transcript, preflight, started } = o;
  const summary: ReviewExecutionSummary = { attempts: [], errorCounts: {}, durationMs: 0, transcript, preflight };
  const retryErrors: ReviewErrorClass[] = [];
  let lease: ReturnType<typeof reviewerConversations.acquire> | undefined;
  const finish = (outcome: "allow" | "deny" | "defer", rationale: string, decision?: ReviewResult["decision"]): ReviewResult => {
    summary.durationMs = Date.now() - started;
    if (!decision) {
      summary.controllerFailure = rationale;
      // Failed provider/controller state must not leave the next review bound
      // to the same rejected history. Forks cannot invalidate another owner.
      lease?.invalidate();
    }
    return { decision: decision ?? { outcome, risk_level: "high", user_authorization: "unknown", rationale }, attempts: summary.attempts.length, retryErrors, durationMs: summary.durationMs, transcript, summary };
  };
  if (transcript.failureCode) return finish("defer", "Required action evidence exceeds the input budget. Reduce the request or expanded context before retrying.");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener("abort", abort, { once: true });
  const deadline = started + config.timeoutMs;
  const timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(0, deadline - Date.now()));
  try {
    const entries = structuredClone(ctx.sessionManager.getBranch());
    const parentId = ctx.sessionManager.getSessionId();
    const snapshot = retainedSnapshot(parentId, entries, config.trustedQuestionTools);
    const parentChanged = () => snapshot !== retainedSnapshot(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), config.trustedQuestionTools);
    const meta = await abortableOperation(o.resolve(ctx, config), controller.signal);
    const auth = await abortableOperation(resolveApiKeyAndHeaders(ctx, meta.model), controller.signal);
    const runtime = { ...meta, auth, sessionId: reviewerSessionId(ctx, config, meta.model, auth) };
    const prompt = conversationPrompt();
    const key = digest([parentId, request.cwd, runtime.sessionId, runtime.model, providerIdentity(runtime.streamSimple), config, prompt]);
    lease = reviewerConversations.acquire(ctx.sessionManager, key, entries, Boolean(config.reviewerConversation));
    summary.conversation = { mode: lease.mode, rounds: 0, investigations: 0, committed: false, historyMessages: lease.messages.length };
    let messages: Message[] = [];
    let admitted = lease.admitted;
    const reset = (reason: "capacity" | "provider-rejection" | "invalid-history") => {
      messages = []; admitted = new Set();
      summary.conversation!.mode = "reset";
      summary.conversation!.resetReason = reason;
    };
    try {
      messages = lease.messages.map(message => {
        if (message.role !== "user" || typeof message.content !== "string") return message;
        const prior = JSON.parse(message.content);
        // Past instructions, overrides and current-action flags must never be
        // carried forward as fresh authority. Only the old action is context.
        return {...message, content: JSON.stringify({ historicalAction: true, request: prior.request })};
      });
    } catch { reset("invalid-history"); }
    const retained = transcript.retainedContext;
    if (!retained) return finish("defer", "Original user instructions are unavailable for review.");
    const evidenceKeys = retained.messages.map(m => digest([m.id, m.role, m.content]));
    const action = conversationAction(o.sharedContext);
    let turn: Message = { role: "user", content: JSON.stringify(action), timestamp: Date.now() };
    const fits = (items: Message[]) => preflightPart(JSON.stringify({ systemPrompt: prompt, messages: items })).estimatedTokens + 256 <= config.maxReviewerInputTokens;
    if (!fits([...messages!, turn])) reset("capacity");
    // Capacity rollover drops old actions/verdicts, not current original
    // instructions. Omissions remain explicit and identical on both paths.
    if (summary.conversation.resetReason) {
      action.reviewerHistoryReset = true;
      turn = { role: "user", content: JSON.stringify(action), timestamp: Date.now() };
    }
    const maxAttempts = Math.min(config.retries + 1, 2);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (controller.signal.aborted) return finish("defer", "Reviewer cancelled or its deadline expired. No action was executed.");
      if (parentChanged()) return finish("defer", "The parent conversation changed during review; review again with current instructions.");
      const requestMessages = [...messages!, turn];
      if (!fits(requestMessages)) return finish("defer", "Required reviewer evidence exceeds the input budget even without review history. Reduce the request or expanded context before retrying.");
      const roundStarted = Date.now();
      const metadata: ProviderAttemptMetadata = {};
      let response: AssistantMessage | undefined, caught: unknown;
      try {
        const context: Context = { systemPrompt: prompt, messages: requestMessages };
        response = await abortableOperation(modelCall(runtime, config, controller, "", config.maxTokens, Math.max(1, deadline - Date.now()), false, metadata, context), controller.signal) as AssistantMessage;
      } catch (error) { caught = error; }
      let decision: ReviewResult["decision"] | undefined;
      let errorClass: ReviewErrorClass = controller.signal.aborted ? timedOut ? "timeout" : "abort"
        : response?.stopReason === "length" ? "output_limit"
        : response?.stopReason === "stop" ? "none" : classifyProviderFailure(response, caught, metadata);
      let status: ReviewAttemptStatus = caught ? "transport_failure" : errorClass === "none" ? "success" : "non_stop";
      let reason = response ? `Reviewer stopped with ${response.stopReason} (${errorClass}); output budget ${config.maxTokens} tokens. No action was executed.` : `Reviewer unavailable (${errorClass}); no action was executed.`;
      if (response && (response.stopReason === "stop" || response.stopReason === "toolUse")) {
        if (response.content.some(p => p.type === "toolCall")) {
          errorClass = "provider_stop"; reason = "Reviewer requested an unavailable tool.";
        } else if (response.stopReason !== "stop") {
          errorClass = "provider_stop"; reason = "Reviewer ended without a decision.";
        } else {
          try { decision = parseDecision(textFromAssistant(response)); }
          catch (error) { errorClass = parseErrorClass(error); status = "format_error"; reason = "Reviewer returned an invalid decision."; }
        }
      }
      const observation = { attempt, model: `${runtime.model.provider}/${runtime.model.id}`, status, errorClass, stopReason: normalizedStopReason(response?.stopReason), durationMs: Date.now() - roundStarted, willRetry: false, usageAvailability: response ? observedUsage(response).availability : "unavailable" as const, usage: response ? observedUsage(response).usage : {} };
      summary.attempts.push(observation); summary.conversation.rounds++;
      if (errorClass !== "none") summary.errorCounts[errorClass] = (summary.errorCounts[errorClass] ?? 0) + 1;
      if (decision) {
        o.observe?.({ type: "review_attempt", requestId: request.id, surface: request.surface, ...observation });
        if (parentChanged()) {
          lease.invalidate();
          if (decision.outcome === "deny") return finish("deny", decision.rationale, decision);
          return finish("defer", "The parent conversation changed during review; review again with current instructions.");
        }
        if (controller.signal.aborted) return finish("defer", "Reviewer cancelled before completion.");
        messages = [...requestMessages, { ...response!, content: response!.content.filter(p => p.type !== "thinking") }];
        for (const k of evidenceKeys) admitted.add(k);
        summary.conversation.committed = lease.commit(messages, admitted);
        summary.conversation.historyMessages = messages.length;
        return finish(decision.outcome, decision.rationale, decision);
      }
      retryErrors.push(errorClass);
      const contextRejected = errorClass === "request_configuration" && messages!.length > 0 &&
        /context|(?:input|prompt|request).{0,30}(?:too long|too large|exceed|tokens)/i.test(response?.errorMessage ?? (caught instanceof Error ? caught.message : ""));
      let retry = attempt < maxAttempts && !controller.signal.aborted && !parentChanged() && (contextRejected || isRetryableError(errorClass));
      let delay = 0;
      if (retry && contextRejected) {
        reset("provider-rejection"); action.reviewerHistoryReset = true;
        turn = { role: "user", content: JSON.stringify(action), timestamp: Date.now() };
      } else if (retry && isFormatError(errorClass)) {
        action.formatCorrection = FORMAT_RETRY_INSTRUCTION;
        turn = { role: "user", content: JSON.stringify(action), timestamp: Date.now() };
        retry = fits([...messages!, turn]);
      } else if (retry) {
        delay = retryDelayMs(errorClass, metadata);
        retry = Number.isFinite(delay) && Date.now() + delay < deadline;
      }
      observation.willRetry = retry;
      o.observe?.({ type: "review_attempt", requestId: request.id, surface: request.surface, ...observation });
      if (!retry) return finish("defer", reason);
      await abortableDelay(delay, controller.signal);
    }
    return finish("defer", "Automatic review could not complete. No action was executed; retry after resolving the review failure.");
  } catch (error) {
    const kind = controller.signal.aborted ? timedOut ? "timeout" : "abort" : classifyProviderFailure(undefined, error, {});
    if (kind !== "none") summary.errorCounts[kind] = (summary.errorCounts[kind] ?? 0) + 1;
    return finish("defer", controller.signal.aborted ? "Reviewer cancelled or its deadline expired." : `Reviewer unavailable (${kind}); no automatic permission granted.`);
  } finally { clearTimeout(timer); ctx.signal?.removeEventListener("abort", abort); lease?.release(); }
}
