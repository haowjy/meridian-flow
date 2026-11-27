import { t } from "@lingui/core/macro";
import { deletedDestinationCopy } from "@/client/api/meridian-error";
import { DeviceRefusedError } from "@/client/commands/submit";
import { WorkCommandRefused, WorkReturnedError } from "./work-mutations";

export const workClosedSentence = (why: WorkReturnedError["why"]) =>
  why === "work_archived"
    ? t`This Work is archived. Unarchive it to edit.`
    : t`This Work was deleted. Restore it to edit.`;

export function workUpdateFailure(cause: unknown, fallback: string): string {
  if (cause instanceof DeviceRefusedError) return "";
  if (cause instanceof WorkReturnedError) return workClosedSentence(cause.why);
  if (!(cause instanceof WorkCommandRefused) || !cause.code) return fallback;
  return (
    deletedDestinationCopy(cause.code) ??
    (cause.code === "work_not_found" ? t`This Work no longer exists.` : fallback)
  );
}
