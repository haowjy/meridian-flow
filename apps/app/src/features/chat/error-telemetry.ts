/**
 * Telemetry stub for chat-level errors.
 *
 * Captures turn failures and refused Retries with their underlying cause so
 * we can report to an external sink; the writer only ever sees generic copy. For now this only console.warn's; the TODO marks
 * where a Sentry-style integration will go.
 */

export interface ChatErrorReport {
  turnId: string;
  threadId: string;
  category: "agent_run" | "tool" | "connection";
  /** The plain-language line shown to the user. */
  userMessage: string;
  /** The underlying raw error string from the turn. */
  raw: string;
  occurredAt: Date;
}

export function reportChatError(report: ChatErrorReport): void {
  // TODO(telemetry): wire to Sentry-style sink. For now, log only.
  console.warn("[chat-error]", report);
}

export interface RetryRefusedReport {
  threadId: string;
  /** The turn whose Retry the writer pressed. */
  from: string;
  status: number | undefined;
  /** The server's refusal, with its code, for diagnostics only. */
  error: unknown;
}

export function reportRetryRefused(report: RetryRefusedReport): void {
  // TODO(telemetry): wire to Sentry-style sink. For now, log only.
  console.warn("[chat-retry-refused]", report);
}
