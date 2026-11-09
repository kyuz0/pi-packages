import { withQuestionAnswers } from "./question-answers.ts";
import { createHash } from "node:crypto";
import type { TranscriptResult } from "../policy.ts";

export type RetainedMessage = { id: string; order: number; role: "user" | "assistant"; content: string; source?: "trusted-question-tool" };
export type RetainedContext = {
  messages: RetainedMessage[];
  omittedUserMessages: number;
  omittedNewestUserMessage: boolean;
  omittedAssistantMessages: number;
  source: "active-session-branch";
  provenance: "session-role-not-independent-human-attestation";
};
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
function visibleText(content: unknown): { text: string; omitted: boolean } {
  if (typeof content === "string") return { text: content, omitted: false };
  if (!Array.isArray(content)) return { text: "", omitted: true };
  const text: string[] = [];
  let omitted = false;
  for (const value of content) {
    const part = object(value);
    if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part?.type !== "thinking" && part?.type !== "toolCall") omitted = true;
  }
  return { text: text.join("\n"), omitted };
}
/** Only original messages on the active branch. Never promote a summary or custom message. */
export function retainContext(entries: readonly unknown[], userBytes = 98_304, assistantBytes = 2048, trustedQuestionTools: readonly string[] = []): RetainedContext {
  const candidates: Array<RetainedMessage & { incomplete: boolean }> = [];
  for (const [order, value] of withQuestionAnswers(entries, trustedQuestionTools).entries()) {
    const entry = object(value);
    const message = object(entry?.message);
    if (entry?.type !== "message" || typeof entry.id !== "string" || !message) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const metadata = object(message.metadata);
    if (metadata?.["compaction.summary"] || metadata?.["branch.summary"]) continue;
    const content = visibleText(message.content);
    if (!content.text && !content.omitted) continue;
    candidates.push({ id: entry.id, order, role: message.role, content: content.text, incomplete: content.omitted,
      ...(entry.reviewerQuestionTool ? {source: "trusted-question-tool" as const} : {}) });
  }
  const selected: RetainedMessage[] = [];
  let omittedUserMessages = 0, omittedAssistantMessages = 0;
  for (const message of candidates.filter(m => m.role === "user").reverse()) {
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (message.incomplete || !message.content || bytes > userBytes) {
      omittedUserMessages++; continue;
    }
    const { incomplete: _, ...whole } = message;
    selected.push(whole); userBytes -= bytes;
  }
  // Keep visible assistant replies nearest retained user messages, so "yes" has
  // a referent. They remain non-authoritative and cannot displace user messages.
  const userOrders = selected.map(m => m.order);
  let nextUserOrder: number | undefined;
  for (const message of [...candidates].reverse()) {
    if (message.role === "user") { nextUserOrder = message.order; continue; }
    const bytes = Buffer.byteLength(message.content, "utf8");
    if (nextUserOrder === undefined || !userOrders.includes(nextUserOrder) || message.incomplete || bytes > assistantBytes) {
      omittedAssistantMessages++; continue;
    }
    selected.push({ id: message.id, order: message.order, role: message.role, content: message.content });
    assistantBytes -= bytes;
  }
  const newestUser = candidates.filter(m => m.role === "user").at(-1);
  const omittedNewestUserMessage = Boolean(newestUser && !selected.some(m => m.id === newestUser.id));
  return { messages: selected.sort((a,b) => a.order-b.order), omittedUserMessages, omittedNewestUserMessage, omittedAssistantMessages,
    source: "active-session-branch", provenance: "session-role-not-independent-human-attestation" };
}
export function retainedSnapshot(sessionId: string, entries: readonly unknown[], trustedQuestionTools: readonly string[] = []): string {
  // Compaction appends a summary but preserves original branch messages. Hash
  // original instruction evidence, never summaries or observational entries.
  // Full user contents and IDs detect edits, new restrictions and branch changes.
  const evidence = withQuestionAnswers(entries, trustedQuestionTools).flatMap(value => {
    const entry = object(value), message = object(entry?.message);
    if (entry?.type !== "message" || !message) return [];
    const metadata = object(message.metadata);
    if (metadata?.["compaction.summary"] || metadata?.["branch.summary"]) return [];
    if (message.role === "user") return [{ id: entry.id, message }];
    if (message.role === "assistant" && visibleText(message.content).text)
      return [{ id: entry.id, message: { role: message.role, content: visibleText(message.content).text } }];
    return [];
  });
  return createHash("sha256").update(sessionId).update(JSON.stringify(evidence)).digest("hex");
}
export function withRetainedContext(transcript: TranscriptResult, entries: readonly unknown[], maxReviewerInputTokens = 32_768, trustedQuestionTools: readonly string[] = []): TranscriptResult {
  // This is only a selection bound. The full serialized request and policy
  // must still pass applyReviewerInputBudget before any provider call.
  const retainedContext = retainContext(entries, maxReviewerInputTokens * 3, maxReviewerInputTokens, trustedQuestionTools);
  return { ...transcript, retainedContext,
    reviewerEvidence: { ...transcript.reviewerEvidence, userMessages: [] },
    selectedCandidates: transcript.selectedCandidates.filter(c => c.kind !== "user"),
    userCharacters: retainedContext.messages.filter(m => m.role === "user").reduce((n,m)=>n+m.content.length,0),
    truncated: transcript.truncated || retainedContext.omittedUserMessages > 0 || retainedContext.omittedAssistantMessages > 0,
    userAuthorizationCeiling: retainedContext.messages.some(m=>m.role === "user") ? "high" : "unknown",
    compactionState: retainedContext.messages.some(m=>m.role === "user") ? "none" : "authorization-unavailable",
  };
}
