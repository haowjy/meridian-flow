/**
 * Telemetry stub for chat-level errors.
 *
 * Captures refused Retries with their underlying cause so
 * we can report to an external sink; the writer only ever sees generic copy. For now this only console.warn's; the TODO marks
 * where a Sentry-style integration will go.
 */

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
