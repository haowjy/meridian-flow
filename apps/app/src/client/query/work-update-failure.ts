/**
 * What the writer reads when a Work update (goal or rename) did not apply. Only a failure the
 * writer can act on gets its own line; anything else, a network drop included, is the caller's
 * plain retry line.
 */
import { t } from "@lingui/core/macro";
import { deletedDestinationCopy } from "@/client/api/meridian-error";
import { DeviceRefusedError } from "@/client/commands/submit";
import { WorkCommandRefused, WorkReturnedError } from "./work-mutations";

/** The words for a closed Work, which a field shows on its trailing chip and as its sentence. */
export const workClosedSentence = (why: WorkReturnedError["why"]) =>
  why === "work_archived"
    ? t`This Work is archived. Unarchive it to edit.`
    : t`This Work was deleted. Restore it to edit.`;

export function workUpdateFailure(cause: unknown, fallback: string): string {
  // The device-refusal toast already said it; the field keeps its draft and adds no second line.
  if (cause instanceof DeviceRefusedError) return "";
  if (cause instanceof WorkReturnedError) return workClosedSentence(cause.why);
  if (!(cause instanceof WorkCommandRefused) || !cause.code) return fallback;
  return (
    deletedDestinationCopy(cause.code) ??
    (cause.code === "work_not_found" ? t`This Work no longer exists.` : fallback)
  );
}
