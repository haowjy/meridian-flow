/**
 * ManuscriptStateNotice — a line under the identity row saying what live did to the document
 * this draft holds (D79): deleted from the manuscript (Apply brings it back), or its name now
 * taken by another document. Once an Apply brings it back the same line says so, until the
 * writer dismisses it or opens another document; a host swap on promotion (the phone's)
 * remounts this line and must not end it. Renders nothing otherwise.
 */
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Info, X } from "lucide-react";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import type { ContextTab } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { RestoredSentence } from "@/features/draft-review/CommandNotice";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { isDeletedFromManuscript, isPathTaken } from "@/features/draft-review/deleted-drafts";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";
import { deletedFromManuscriptSentence } from "@/features/project/context/RemovedDocumentNotice";
import { useRemovalRecord } from "@/features/project/context/use-removal-record";

export function ManuscriptStateNotice({ projectId, tab }: { projectId: string; tab: ContextTab }) {
  useLingui();
  const { documentId } = tab;
  const { files } = useDraftReview();
  const owner = useDraftCommandOwner();
  const restored = useSyncExternalStore(
    owner.subscribe,
    () => owner.wasRestored(projectId, documentId),
    () => false,
  );
  useEffect(() => owner.keepRestoredOnly(projectId, documentId), [owner, projectId, documentId]);
  const item = files.find((file) => file.documentId === documentId)?.draft;
  const deleted = isDeletedFromManuscript(item);
  const removal = useRemovalRecord(projectId, deleted ? documentId : null);
  const title = tab.name;
  let line: ReactNode = null;
  if (isPathTaken(item))
    line = (
      <Trans>Another document now has this name. Rename that document to apply this draft.</Trans>
    );
  else if (deleted)
    line = deletedFromManuscriptSentence(
      title,
      removal?.kind === "removed" ? removal.record : null,
    );
  else if (restored) line = <RestoredSentence titles={[title]} />;
  if (!line) return null;
  return (
    <div
      role="status"
      data-manuscript-state-notice={
        restored && !deleted ? "restored" : deleted ? "deleted" : "taken"
      }
      className="flex min-h-8 min-w-0 items-center gap-x-2 px-4 font-sans text-ink-muted text-sm [@media(pointer:coarse)]:min-h-11"
    >
      <Info aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{line}</span>
      {restored && !deleted ? (
        <IconButton
          aria-label={t`Dismiss`}
          className="size-6 shrink-0 [@media(pointer:coarse)]:size-11"
          onClick={() => owner.forgetRestored(projectId, documentId)}
        >
          <X aria-hidden className="size-3" />
        </IconButton>
      ) : null}
    </div>
  );
}
