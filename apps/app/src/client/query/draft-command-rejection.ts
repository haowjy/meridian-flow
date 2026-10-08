/**
 * draft-command-rejection — what a failed Apply or Discard request was, from
 * the error it threw. The one place that decides between the three kinds of
 * failure the writer is told about differently:
 *
 * - `offline`: the request never got an HTTP answer (the browser is offline,
 *   or the connection dropped). Only here is "check your connection" true.
 * - `refused`: the server answered with its typed error envelope. Its message
 *   is the reason, shown as the server wrote it.
 * - `server-error`: the server answered with an error and no reason (a bare
 *   5xx). Nothing is known about the connection or the cause.
 *
 * Decided from the error's type and typed envelope, never from its message.
 */
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";

export type DraftCommandRejection =
  | { kind: "offline" }
  | { kind: "refused"; reason: string | undefined }
  | { kind: "server-error" };

export function classifyDraftCommandRejection(error: unknown): DraftCommandRejection {
  if (isMeridianApiError(error)) {
    const reason = error.message.trim();
    return { kind: "refused", reason: reason || undefined };
  }
  return httpErrorStatus(error) === undefined ? { kind: "offline" } : { kind: "server-error" };
}
