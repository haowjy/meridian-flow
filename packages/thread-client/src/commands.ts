/** Attempt facts held by command owners, never allocated by a display projection. */
import type { CommandFailureInput } from "@meridian/contracts/failures";

export type Occurrence = { requestId: string; attempt: number };
export type CommandFailure = Occurrence & CommandFailureInput;
export type FailedCommand =
  | { failed?: false; failure?: never }
  | { failed: true; failure: CommandFailure };

export function occurrenceKey(occurrence: Occurrence): string {
  return `${occurrence.requestId}:${occurrence.attempt}`;
}

export function nextOccurrence(previous: Occurrence): Occurrence {
  return { requestId: previous.requestId, attempt: previous.attempt + 1 };
}
