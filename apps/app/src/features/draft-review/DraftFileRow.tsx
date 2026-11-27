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
import { DraftImagePreview } from "./DraftImagePreview";
import type { HeldNoticeRows } from "./draft-command-owner";
import { ReviewActions } from "./ReviewActions";
import { landingFaultSentence } from "./tree-groups";
import { opensAsDocument, treeLineOf } from "./tree-line";
import type { WorkDraftCommands } from "./usePressCommands";

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
  onCommand?: () => HeldNoticeRows;
  notice: ReactNode;
  depth: number;
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
    void controller.pressDocument(
      "discard",
      {
        documentId: file.documentId,
        itemKey: file.item.itemKey,
      },
      onCommand?.(),
    );
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
            row
            touch={touch}
            disabled={controller.dispositionLocked}
            className={touch ? "gap-0" : "gap-0.5"}
            onDiscard={discard}
            onApply={
              canApply
                ? () => {
                    void controller.pressDocument(
                      "apply",
                      {
                        documentId: file.documentId,
                        itemKey: file.item.itemKey,
                      },
                      onCommand?.(),
                    );
                  }
                : undefined
            }
          />
        }
        below={
          fault ? (
            <div className="pl-1">
              <InlineErrorRow message={landingFaultSentence(fault)} className="p-0 text-xs" />
            </div>
          ) : null
        }
      />
      <DraftImagePreview
        target={previewing ? { projectId, draftId, documentId: file.documentId, name } : null}
        onClose={() => setPreviewing(false)}
      />
    </li>
  );
}

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
  if (!tree) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2">
      <span className="min-w-0 truncate">{tree}</span>
    </span>
  );
}

function folderPlace(location: NonNullable<ReviewFileTarget["contextLocation"]>): string {
  const folders = location.path.split("/").filter(Boolean).slice(0, -1);
  const source = location.scheme ? schemeLabel(location.scheme) : null;
  return [source, ...folders].filter(Boolean).join("/");
}
