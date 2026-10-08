/**
 * draft-command-rejection — what a failed Apply or Discard request was, from
 * the error it threw. The one place that decides between the three kinds of
 * failure the writer is told about differently:
 *
 * - `offline`: the request never got an HTTP answer (the browser is offline,
 *   or the connection dropped). Only here is "check your connection" true.
 * - `refused`: the server answered with its typed error envelope. A code the
 *   writer can act on is worded here, in the writer's language; only an
 *   unrecognised code falls back to the server's own message.
 * - `server-error`: the server answered with an error and no reason (a bare
 *   5xx). Nothing is known about the connection or the cause.
 *
 * Decided from the error's type and typed envelope, never from its message.
 */
import { t } from "@lingui/core/macro";
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";

export type DraftCommandRejection =
  | { kind: "offline" }
  | { kind: "refused"; reason: string | undefined }
  | { kind: "server-error" };

export function classifyDraftCommandRejection(error: unknown): DraftCommandRejection {
  if (isMeridianApiError(error)) {
    const reason = refusalReason(error.code) ?? error.message.trim();
    return { kind: "refused", reason: reason || undefined };
  }
  return httpErrorStatus(error) === undefined ? { kind: "offline" } : { kind: "server-error" };
}

function refusalReason(code: string): string | undefined {
  switch (code) {
    case "work_archived":
      return t`This Work is archived. Unarchive it to apply or discard its drafts.`;
    case "work_not_found":
      return t`This Work no longer exists.`;
    case "draft_not_found":
    case "not_found":
      return t`This draft is no longer here. It may have been applied or discarded elsewhere.`;
    default:
      return undefined;
  }
}
