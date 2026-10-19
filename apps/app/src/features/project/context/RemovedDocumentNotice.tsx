/** What the Editor says when a document it showed was deleted or discarded by someone else. */
import { Trans } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import {
  useContextRemovalCoordinator,
  useOptionalProjectContextAvailabilityCoordinator,
} from "./account-feature-context";
import { describeRemoval, type RemovedDocumentNotice } from "./context-removal-coordinator";
import { useContextRemovalProject } from "./use-context-removal-project";

export type DocumentRemoval = Pick<RemovedDocumentNotice, "title" | "reason" | "actorName">;

export function RemovedDocumentSentence({ title, reason, actorName }: DocumentRemoval) {
  if (reason === "discarded")
    return (
      <Trans>
        <strong>{title}</strong> was discarded from the draft.
      </Trans>
    );
  return actorName ? (
    <Trans>
      <strong>{title}</strong> was deleted by {actorName}.
    </Trans>
  ) : (
    <Trans>
      <strong>{title}</strong> was deleted.
    </Trans>
  );
}

/**
 * Notes for tabs that closed under the writer, floated over the pane's foot,
 * where the closed tab's place leaves the pane blank. Each stays until dismissed.
 */
export function RemovedDocumentNotices({ projectId }: { projectId: string }) {
  const removal = useContextRemovalCoordinator();
  const notices = useContextRemovalProject(projectId).notices;
  if (notices.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4">
      {notices.map((notice) => (
        <div
          key={notice.documentId}
          data-removed-document-notice={notice.documentId}
          className="pointer-events-auto w-full max-w-md shadow-card"
        >
          <FailureCard
            tone="info"
            onDismiss={() => removal.dismissRemovedNotice(projectId, notice.documentId)}
          >
            <p className="min-w-0 flex-1 break-words">
              <RemovedDocumentSentence {...notice} />
            </p>
          </FailureCard>
        </div>
      ))}
    </div>
  );
}

/**
 * Why an unavailable destination is gone, when it names its document: a
 * removed one says who removed it instead of "unavailable". `checking` while
 * the exact lookup runs, so the destination never shows one verdict, then another.
 */
export function useRemovedDestination(
  projectId: string,
  documentId: string | null,
  title: string,
): { status: "none" | "checking" } | { status: "removed"; removal: DocumentRemoval } {
  const availability = useOptionalProjectContextAvailabilityCoordinator();
  const [answer, setAnswer] = useState<{
    key: string;
    removal: DocumentRemoval | null;
  } | null>(null);
  const key = JSON.stringify([projectId, documentId, title]);
  useEffect(() => {
    if (!documentId || !availability) return;
    let current = true;
    void availability.resolveForOpen(projectId, documentId).then(
      (resolution) => {
        if (!current) return;
        setAnswer({
          key,
          removal:
            resolution.kind === "deleted"
              ? describeRemoval(title, resolution.removal ?? null)
              : null,
        });
      },
      () => {
        if (current) setAnswer({ key, removal: null });
      },
    );
    return () => {
      current = false;
    };
  }, [availability, documentId, key, projectId, title]);
  if (!documentId || !availability) return { status: "none" };
  if (answer?.key !== key) return { status: "checking" };
  return answer.removal ? { status: "removed", removal: answer.removal } : { status: "none" };
}
