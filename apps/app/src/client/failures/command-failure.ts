/** Classify command errors without copying response text into diagnostics. */
import type { CommandFailureInput } from "@meridian/contracts/failures";
import { httpErrorStatus, InvalidResponseError } from "../api/http-client";
export function commandFailureInput(error: unknown): CommandFailureInput {
  const status = httpErrorStatus(error);
  return {
    kind: status !== undefined && status >= 400 && status < 500 ? "refused" : "lost",
    status,
    ...(error instanceof InvalidResponseError ? { code: "malformed_response" } : {}),
  };
}
