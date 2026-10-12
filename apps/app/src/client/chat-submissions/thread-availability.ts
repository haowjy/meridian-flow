/** Classify only the owner gate's definitive destination-disappearance proof. */
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";
import { lookupUserMessageAdmission } from "@/client/api/threads-api";
import { abortable } from "./lock";

export function isThreadMissingForAccount(error: unknown, accountId: string): boolean {
  if (
    httpErrorStatus(error) !== 404 ||
    !isMeridianApiError(error) ||
    error.code !== "thread_not_found"
  )
    return false;
  const details = error.details;
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    details.authenticatedUserId !== accountId
  ) {
    reportError(new Error("Thread disappearance principal does not match the journal account"));
    return false;
  }
  return true;
}

/** Read-only admission lookup checks the owner gate without loading history or minting a record. */
export async function probeChatDestination(
  accountId: string,
  threadId: string,
  submissionId: string,
  lookup: typeof lookupUserMessageAdmission = lookupUserMessageAdmission,
  signal = AbortSignal.timeout(15_000),
): Promise<"missing" | "unknown"> {
  try {
    await abortable(lookup({ threadId, submissionId, signal }), signal);
  } catch (error) {
    if (isThreadMissingForAccount(error, accountId)) return "missing";
  }
  return "unknown";
}
