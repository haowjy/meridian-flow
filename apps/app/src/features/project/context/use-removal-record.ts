/** React subscription to one document's removal answer in the account's record cache. */
import { useMemo, useSyncExternalStore } from "react";
import { useOptionalProjectContextAvailabilityCoordinator } from "./account-feature-context";
import type { RemovalAnswer } from "./project-context-availability-coordinator";

const unsubscribed = () => undefined;
const subscribeNothing = () => unsubscribed;

/**
 * Whether and how a document was removed. Subscribing asks: the first
 * subscriber looks it up unless an answer or an open is already pending, and
 * the availability watch keeps asking until it is `removed` or `lost`.
 * Undefined while nothing is known; a null `documentId` asks nothing.
 */
export function useRemovalRecord(
  projectId: string,
  documentId: string | null,
): RemovalAnswer | undefined {
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const handle = useMemo(
    () =>
      availability && projectId && documentId
        ? availability.removalRecord(projectId, documentId)
        : null,
    [availability, documentId, projectId],
  );
  return useSyncExternalStore(
    handle?.subscribe ?? subscribeNothing,
    () => handle?.get(),
    () => undefined,
  );
}
