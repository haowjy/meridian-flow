/**
 * What the writer reads when a Work update (goal or rename) is refused. Only a
 * refusal the writer can act on gets its own line, read from the server's
 * error code; anything else, a network drop included, is the caller's plain
 * retry line.
 */
import { t } from "@lingui/core/macro";
import { WorkCommandRefused } from "./work-mutations";

export function workUpdateFailure(cause: unknown, fallback: string): string {
  if (!(cause instanceof WorkCommandRefused)) return fallback;
  switch (cause.reason) {
    case "name_conflict":
      return t`Another Work already has this name. Choose a different name.`;
    case "unavailable":
      return cause.state === "archived"
        ? t`This Work is archived. Unarchive it to edit.`
        : t`This Work no longer exists.`;
    case "locked":
      return t`This Work is archived. Unarchive it to edit.`;
    default:
      return fallback;
  }
}
