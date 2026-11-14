/**
 * What the writer reads when a Work update (goal or rename) is refused. Only a
 * refusal the writer can act on gets its own line, read from the server's
 * error code; anything else, a network drop included, is the caller's plain
 * retry line.
 */
import { t } from "@lingui/core/macro";
import { isMeridianApiError } from "@/client/api/http-client";
import { deletedDestinationCopy } from "@/client/api/meridian-error";

/** The server left a closed Work as it stands: the writer's edit did not apply. */
export class WorkReturnedError extends Error {
  readonly name = "WorkReturnedError";
  constructor(readonly why: "work_archived" | "work_deleted") {
    super(why);
  }
}

export function workUpdateFailure(cause: unknown, fallback: string): string {
  if (cause instanceof WorkReturnedError)
    return cause.why === "work_archived"
      ? t`This Work is archived. Unarchive it to edit.`
      : t`This Work was deleted. Restore it to edit.`;
  const deleted = isMeridianApiError(cause)
    ? deletedDestinationCopy(cause.code, cause.details)
    : null;
  if (deleted) return deleted;
  switch (isMeridianApiError(cause) ? cause.code : null) {
    case "work_not_found":
      return t`This Work no longer exists.`;
    default:
      return fallback;
  }
}
