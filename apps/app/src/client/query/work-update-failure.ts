/**
 * What the writer reads when a Work update (goal or rename) is refused. Only a
 * refusal the writer can act on gets its own line, read from the server's
 * error code; anything else, a network drop included, is the caller's plain
 * retry line.
 */
import { t } from "@lingui/core/macro";
import { deletedDestinationCopy } from "@/client/api/meridian-error";
import { WorkCommandRefused } from "./work-mutations";

export function workUpdateFailure(cause: unknown, fallback: string): string {
  if (!(cause instanceof WorkCommandRefused)) return fallback;
  const deleted = cause.code ? deletedDestinationCopy(cause.code) : null;
  if (deleted) return deleted;
  return copyFor(cause.code, cause) ?? copyFor(cause.reason, cause) ?? fallback;
}

function copyFor(key: string | null, cause: WorkCommandRefused): string | null {
  switch (key) {
    case "work_archived":
      return t`This Work is archived. Unarchive it to edit.`;
    case "work_not_found":
      return t`This Work no longer exists.`;
    case "work_name_conflict":
    case "name_conflict":
      return t`Another Work already has this name. Choose a different name.`;
    case "returned":
      return cause.state === "work_archived"
        ? t`This Work is archived. Unarchive it to edit.`
        : t`This Work no longer exists.`;
    case "unavailable":
      return cause.state === "archived"
        ? t`This Work is archived. Unarchive it to edit.`
        : t`This Work no longer exists.`;
    default:
      return null;
  }
}
