/** Classify only the owner gate's definitive destination-disappearance proof. */
import { httpErrorStatus, isMeridianApiError } from "@/client/api/http-client";
import { lookupUserMessageAdmission } from "@/client/api/threads-api";
import { abortable } from "./lock";

export function isThreadNotFound(error: unknown): boolean {
  return (
    httpErrorStatus(error) === 404 && isMeridianApiError(error) && error.code === "thread_not_found"
  );
}

/** Read-only admission lookup checks the owner gate without loading history or minting a record. */
export async function probeChatDestination(
  threadId: string,
  submissionId: string,
  lookup: typeof lookupUserMessageAdmission = lookupUserMessageAdmission,
  signal = AbortSignal.timeout(15_000),
): Promise<"missing" | "unknown"> {
  try {
    await abortable(lookup({ threadId, submissionId, signal }), signal);
  } catch (error) {
    if (isThreadNotFound(error)) return "missing";
  }
  return "unknown";
}
