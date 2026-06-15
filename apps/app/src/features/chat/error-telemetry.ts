/**
 * Telemetry stub for chat-level turn errors.
 *
 * Captures when a turn transitions to an errored state so we can report
 * to an external sink. For now this only console.warn's; the TODO marks
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
