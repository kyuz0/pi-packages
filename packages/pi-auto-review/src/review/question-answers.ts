/** Host-configured question tools return user choices in structured details.
 * Tool text, unmatched calls, errors and cancelled dialogs never supply approval.
 */
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const text = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim());

export function withQuestionAnswers(entries: readonly unknown[], trustedTools: readonly string[] = []): unknown[] {
  const calls = new Map<string, { name: string; questions: unknown[] }>();
  const used = new Set<string>();
  return entries.map(value => {
    const entry = record(value), message = record(entry?.message);
    if (entry?.type !== "message" || !message) return value;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        const call = record(item), args = record(call?.arguments);
        if (call?.type === "toolCall" && text(call.id) && text(call.name) && trustedTools.includes(call.name) && Array.isArray(args?.questions)) {
          // Duplicate IDs cannot replace a previously registered question.
          if (calls.has(call.id)) used.add(call.id);
          else calls.set(call.id, { name: call.name, questions: args.questions });
        }
      }
      return value;
    }
    if (message.role !== "toolResult" || message.isError || !text(message.toolCallId) || used.has(message.toolCallId)) return value;
    const call = calls.get(message.toolCallId);
    if (!call || message.toolName !== call.name) return value;
    used.add(message.toolCallId);
    const details = record(message.details);
    if (!details || details.cancelled !== false || details.error || !Array.isArray(details.answers) || !details.answers.length) return value;
    const answers: unknown[] = [], indices = new Set<number>();
    for (const raw of details.answers) {
      const answer = record(raw);
      if (!answer || !Number.isInteger(answer.questionIndex)) return value;
      const index = answer.questionIndex as number, question = record(call.questions[index]);
      if (index < 0 || indices.has(index) || !question || !text(question.question) || answer.question !== question.question || !Array.isArray(question.options)) return value;
      indices.add(index);
      const options = question.options.map(record);
      const selected: Record<string, unknown>[] = [];
      if (answer.kind === "option") {
        const option = options.filter(o => o && o.label === answer.answer);
        if (!text(answer.answer) || option.length !== 1) return value;
        selected.push(option[0]!);
      } else if (answer.kind === "multi") {
        if (question.multiSelect !== true || !Array.isArray(answer.selected) || new Set(answer.selected).size !== answer.selected.length) return value;
        for (const label of answer.selected) {
          const option = options.filter(o => o && o.label === label);
          if (!text(label) || option.length !== 1) return value;
          selected.push(option[0]!);
        }
        if (!selected.length && !text(answer.answer)) continue;
        if (answer.answer !== null && !text(answer.answer)) return value;
      } else if (answer.kind === "custom") {
        if (!text(answer.answer)) continue;
      } else return value;
      if (answer.notes !== undefined && !text(answer.notes)) return value;
      answers.push({ question: question.question, answer: answer.answer,
        ...(selected.length ? { selectedOptions: selected.map(o => ({label:o.label,description:o.description,preview:o.preview})) } : {}),
        ...(answer.notes ? { notes: answer.notes } : {}) });
    }
    if (!answers.length || (details.globalNote !== undefined && !text(details.globalNote))) return value;
    return { ...entry, reviewerQuestionTool: call.name, message: {
      role: "user", content: JSON.stringify({ source: "user-answer-to-question", tool: call.name, answers,
        ...(details.globalNote ? { globalNote: details.globalNote } : {}) }),
    }};
  });
}
