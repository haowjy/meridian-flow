/** Classify only the owner gate's definitive destination-disappearance proof. */
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";
import { lookupUserMessageAdmission } from "@/client/api/threads-api";
import { abortable } from "./lock";

export type ThreadAvailability = "deleted" | "project-deleted" | "not-found";
export function threadAvailability(error: unknown, accountId: string): ThreadAvailability | null {
  if (
    httpErrorStatus(error) !== 404 ||
    !isMeridianApiError(error) ||
    !["thread_not_found", "thread_deleted", "project_deleted"].includes(error.code)
  )
    return null;
  const details = error.details;
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    details.authenticatedUserId !== accountId
  )
    return null;
  if (
    error.code === "project_deleted" ||
    (error.code === "thread_deleted" && details.projectDeleted === true)
  )
    return "project-deleted";
  return error.code === "thread_deleted" ? "deleted" : "not-found";
}

/** Read-only admission lookup checks the owner gate without loading history or minting a record. */
export async function probeChatDestination(
  accountId: string,
  threadId: string,
  submissionId: string = crypto.randomUUID(),
  lookup: typeof lookupUserMessageAdmission = lookupUserMessageAdmission,
  signal = AbortSignal.timeout(15_000),
): Promise<ThreadAvailability | "present" | "unknown"> {
  try {
    await abortable(lookup({ threadId, submissionId, signal }), signal);
  } catch (error) {
    return threadAvailability(error, accountId) ?? "unknown";
  }
  return "present";
}
