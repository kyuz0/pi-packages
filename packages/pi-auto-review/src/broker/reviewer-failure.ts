/** Only fixed classifications reach UI/audit; provider errors may contain secrets. */
export function reviewerFailure(error: unknown): { errorClass: string; reason: string } {
  const code = error && typeof error === "object" && "errorClass" in error
    ? error.errorClass : undefined;
  const reasons: Record<string, string> = {
    critical_evidence_overflow: "Action evidence exceeds the review input limit. Reduce the request or increase the configured limit.",
    required_profile_overflow: "Required instructions exceed the review input limit. Reduce their size or increase the configured limit.",
    reviewer_input_budget_exceeded: "Review input exceeds its configured limit. Reduce the request or increase the limit.",
    parent_changed: "Instructions changed during review. Retry with the current instructions.",
    missing_instructions: "Original instructions are unavailable. Restore the session or provide the task instructions again.",
    provider_stop: "Reviewer ended without a valid decision. Retry the review.",
    rate_limit: "Reviewer model is busy (rate limit). Retry shortly.",
    transient_server: "Reviewer provider is temporarily unavailable. Retry shortly.",
    transient_connection: "Cannot reach the reviewer provider. Check its connection and retry.",
    authentication: "Reviewer authentication failed. Check the configured model credentials.",
    model_resolution: "Reviewer model is unavailable. Select an available model and retry.",
    request_configuration: "Reviewer provider rejected the request. Check model configuration and context limits.",
    timeout: "Reviewer timed out waiting for model capacity or a response. Retry shortly.",
    abort: "Review was cancelled. Retry if the operation is still needed.",
    output_limit: "Reviewer reached its output limit. Retry with a model that supports the configured budget.",
    non_json: "Reviewer returned an invalid decision. Retry the review.",
    schema: "Reviewer returned an invalid decision. Retry the review.",
    empty_output: "Reviewer returned no decision. Retry the review.",
  };
  return typeof code === "string" && Object.hasOwn(reasons, code)
    ? { errorClass: code, reason: reasons[code]! }
    : { errorClass: "reviewer_unavailable", reason: "Automatic review is unavailable. Retry the review." };
}
