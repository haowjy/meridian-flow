/**
 * What the writer reads when a Work update (goal or rename) is refused. Only a
 * refusal the writer can act on gets its own line, read from the server's
 * error code; anything else, a network drop included, is the caller's plain
 * retry line.
 */
import { t } from "@lingui/core/macro";
import { isMeridianApiError } from "@/client/api/http-client";

export function workUpdateFailure(cause: unknown, fallback: string): string {
  switch (isMeridianApiError(cause) ? cause.code : null) {
    case "work_archived":
      return t`This Work is archived. Unarchive it to edit.`;
    case "work_not_found":
      return t`This Work no longer exists.`;
    case "work_name_conflict":
      return t`Another Work already has this name. Choose a different name.`;
    default:
      return fallback;
  }
}
