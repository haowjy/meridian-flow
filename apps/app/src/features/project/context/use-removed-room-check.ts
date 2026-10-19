/** What availability says about a room the server closed because its document was removed (4208). */
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import { useEffect, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import { useOptionalProjectContextAvailabilityCoordinator } from "./account-feature-context";

/**
 * `available`: the document is there after all (a restore, or a stale close),
 * so its owner restarts the room. `removed`: it is gone; its record when the
 * server has one. Null while the room is not closed as removed, while the
 * lookup runs, and after an authority loss, which closes the tab its own way.
 */
export type RemovedRoomCheck =
  | { status: "available" }
  | { status: "removed"; record: DocumentRemovalRecord | null };

/**
 * One exact lookup per close. The account lifetime asks for every live room
 * the moment it closes; this joins that request while it is in flight.
 */
export function useRemovedRoomCheck(
  projectId: string,
  documentId: string,
  session: DocumentSession | null,
): RemovedRoomCheck | null {
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const [answer, setAnswer] = useState<{
    session: DocumentSession;
    check: RemovedRoomCheck | null;
  } | null>(null);
  useEffect(() => {
    if (!session || !availability || !projectId || !documentId) return;
    let current = true;
    let asked = false;
    const observe = () => {
      if (session.resetDisposition !== "removed") {
        asked = false;
        return;
      }
      if (asked) return;
      asked = true;
      setAnswer({ session, check: null });
      void availability.resolveForOpen(projectId, documentId).then(
        (resolution) => {
          if (!current || session.resetDisposition !== "removed") return;
          setAnswer({
            session,
            check:
              resolution.kind === "available"
                ? { status: "available" }
                : resolution.kind === "deleted"
                  ? { status: "removed", record: resolution.removal ?? null }
                  : resolution.kind === "failed" || resolution.kind === "malformed"
                    ? { status: "removed", record: null }
                    : null,
          });
        },
        () => undefined,
      );
    };
    observe();
    const stop = session.subscribe(observe);
    return () => {
      current = false;
      stop();
    };
  }, [availability, documentId, projectId, session]);
  return answer?.session === session && session?.resetDisposition === "removed"
    ? answer.check
    : null;
}
