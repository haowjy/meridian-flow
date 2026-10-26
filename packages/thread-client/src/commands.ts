/** Attempt facts held by command owners, never allocated by a display projection. */
import {
  type CommandFailureInput,
  classifyCommandFailure,
  type FailureEnd,
  type FailureLog,
} from "@meridian/contracts/failures";

export type Occurrence = { requestId: string; attempt: number };
export type CommandFailure = Occurrence &
  CommandFailureInput & {
    /** Stable wire id for journaled commands; requestId identifies the client attempt. */
    submissionId?: string;
  };
export type FailedCommand =
  | { failed?: false; failure?: never }
  | { failed: true; failure: CommandFailure };

export function occurrenceKey(occurrence: Occurrence): string {
  return `${occurrence.requestId}:${occurrence.attempt}`;
}

export function nextOccurrence(previousAttempt: number, requestId: string): Occurrence {
  return { requestId, attempt: previousAttempt + 1 };
}

/** Called by the owner at a state transition, not by a card or render. */
export function logCommandFailure(
  log: FailureLog,
  command: CommandFailure,
  context: { threadId?: string; turnId?: string } = {},
  end?: FailureEnd,
): void {
  log.record({
    occurrenceId: occurrenceKey(command),
    failure: classifyCommandFailure(command),
    requestId: command.requestId,
    ...(command.submissionId ? { submissionId: command.submissionId } : {}),
    ...context,
    ...(end ? { phase: "ended", end } : { phase: "recorded" }),
  });
}
