/**
 * A drafted document as a row, the same in the Changes tab and a chat's draft dock: its name,
 * what the draft does to it in a quiet line, and its × / ✓, always shown. A click opens Review
 * changes on it (a picture opens its preview).
 */
import { t } from "@lingui/core/macro";
import type { LandingFault } from "@meridian/project-tree";
import { type ReactNode, useState } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ListRow } from "@/components/ui/list-row";
import { fileKindIcon } from "@/features/project/context/context-file-icon";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import { useItemLauncher } from "@/features/project/review-launch";
import { cn } from "@/lib/utils";
import { draftCopyView } from "./copy-view";
import { DraftCommandStatus } from "./DraftCommandStatus";
import { DraftImagePreview } from "./DraftImagePreview";
import { ReviewActions } from "./ReviewActions";
import { landingFaultSentence } from "./tree-groups";
import { opensAsDocument, treeLineOf } from "./tree-line";
import type { WorkDraftCommands } from "./usePressCommands";

/**
 * One drafted document: its name, and under it what the draft does to it (a move, rename or
 * delete, a new document, its text changes). Its × and ✓ show on hover or focus, always with a
 * finger. A refused or pending command shows in the status line under it.
 */
export function DraftFileRow({
  projectId,
  draftId,
  file,
  depth,
  fault,
  active,
  canApply,
  controller,
  touch,
  notice,
  onCommand,
  onPicked,
}: {
  projectId: string;
  draftId: string;
  file: ReviewFileTarget;
  /** Right before this row's Discard or Apply: the list holds what it shows. */
  onCommand?: () => void;
  /** What the owner's notice says on this row (`useDraftNoticeWords`). */
  notice: ReactNode;
  /** Under its changed folder's row. */
  depth: number;
  /** Why its tree change cannot land, which stays after Apply as the change stays pending. */
  fault: LandingFault | null;
  active: boolean;
  canApply: boolean;
  controller: WorkDraftCommands;
  touch: boolean;
  onPicked?: () => void;
}) {
  const { openReviewFile } = useItemLauncher();
  const [previewing, setPreviewing] = useState(false);
  const discard = () => {
    onCommand?.();
    void controller.discard(file.documentId, file.item.itemKey);
  };
  const name = file.documentName || file.contextLocation?.path || t`Untitled document`;
  const copyView = draftCopyView(file, draftId);
  const drag = useReferenceDrag(
    copyView ? { ref: { kind: "file", id: file.documentId }, name, view: copyView } : null,
  );
  const reviewable = opensAsDocument(file.item);
  const imageOpenable = file.item.binary;
  const opens = Boolean(file.contextLocation) && (reviewable || imageOpenable);
  const review = () => {
    if (reviewable) {
      openReviewFile(file, draftId);
      onPicked?.();
    } else if (imageOpenable) setPreviewing(true);
  };
  const line = treeLineOf(file.item);
  const deleted = line?.kind === "delete";
  const command = controller.owner.state(file.item.itemKey);

  return (
    <li data-change-row={file.documentId}>
      <ListRow
        onOpen={review}
        depth={depth}
        current={active}
        disabled={!opens}
        controlProps={drag}
        icon={fileKindIcon(file.contextLocation?.path ?? name)}
        title={<span className={cn("truncate", deleted && "line-through")}>{name}</span>}
        detail={changeSummary(file)}
        notice={notice}
        actions={
          <ReviewActions
            scope="document"
            labels={{ apply: t`Apply draft of ${name}`, discard: t`Discard draft of ${name}` }}
            density="icon"
            touch={touch}
            disabled={command.hidden || controller.dispositionLocked}
            className={touch ? "gap-0" : "gap-0.5"}
            onDiscard={discard}
            onApply={
              canApply
                ? () => {
                    onCommand?.();
                    void controller.apply(file.documentId, file.item.itemKey);
                  }
                : undefined
            }
          />
        }
        below={
          <div className="pl-1">
            {fault ? (
              <InlineErrorRow message={landingFaultSentence(fault)} className="p-0 text-xs" />
            ) : null}
            <DraftCommandStatus itemKey={file.item.itemKey} />
          </div>
        }
      />
      <DraftImagePreview
        target={previewing ? { projectId, draftId, documentId: file.documentId, name } : null}
        onClose={() => setPreviewing(false)}
      />
    </li>
  );
}

/**
 * What the draft does to the document, in a quiet line under its name; nothing to say, no line.
 * The row's name is already the draft's, so a rename says what it was.
 */
export function changeSummary(file: ReviewFileTarget) {
  const line = treeLineOf(file.item);
  const place = file.contextLocation ? folderPlace(file.contextLocation) : null;
  const tree = file.item.isNew
    ? place
      ? t`New in ${place}`
      : t`New`
    : line?.kind === "delete"
      ? t`Deleted`
      : line?.kind === "rename"
        ? t`Was ${line.name}`
        : line?.kind === "move"
          ? t`Moving to ${line.place}`
          : line?.kind === "reorder"
            ? t`Changing position`
            : null;
  // A row with text changes says so by being listed: no screen counts them.
  if (!tree) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      <span className="min-w-0 truncate">{tree}</span>
    </span>
  );
}

/** "Manuscript/Arc 3": the source and folder a document lands in. */
function folderPlace(location: NonNullable<ReviewFileTarget["contextLocation"]>): string {
  const folders = location.path.split("/").filter(Boolean).slice(0, -1);
  const source = location.scheme ? schemeLabel(location.scheme) : null;
  return [source, ...folders].filter(Boolean).join("/");
}
