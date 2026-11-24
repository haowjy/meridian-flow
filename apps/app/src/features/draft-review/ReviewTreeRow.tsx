/**
 * Review changes' row for what the draft does to the document itself: a
 * create, a move or rename, or a delete, one row at the top of the page. Its Discard · Apply are
 * the bar's chapter pair, which take the document whole. A deleted document has no plain draft
 * page: Review changes shows Live's text read-only under this row.
 */
import { Trans } from "@lingui/react/macro";
import { FilePlus2, FolderInput, Trash2 } from "lucide-react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { useReviewMode } from "./review-mode";

export function ReviewTreeRow({ documentId }: { documentId: string }) {
  const mode = useReviewMode();
  const rows = useOwnerDrafts(mode?.projectId ?? null, mode?.draftId ?? null).files ?? [];
  if (!mode || mode.documentId !== documentId || mode.target !== "live") return null;
  const row = rows.find((file) => file.documentId === documentId)?.item;
  const tree = row?.tree;
  if (!row || !(tree?.deleted || tree?.movedFrom || row.isNew)) return null;
  const moved = tree?.movedFrom?.path;
  return (
    <div className="px-4 pt-3" data-review-tree-row>
      <DocumentNotice
        icon={
          tree?.deleted ? (
            <Trash2 aria-hidden className="size-4" />
          ) : row.isNew ? (
            <FilePlus2 aria-hidden className="size-4" />
          ) : (
            <FolderInput aria-hidden className="size-4" />
          )
        }
      >
        {tree?.deleted ? (
          <Trans>Deleted in this draft</Trans>
        ) : row.isNew ? (
          <Trans>New in this draft</Trans>
        ) : (
          <Trans>Was {moved}</Trans>
        )}
      </DocumentNotice>
    </div>
  );
}
