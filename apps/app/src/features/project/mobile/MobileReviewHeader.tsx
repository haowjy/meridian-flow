/** Phone review chrome: version, stepper and list control in one row. Completion replaces stepping in that same row; whole commands live in the version menu. */
import { t } from "@lingui/core/macro";
import { List } from "lucide-react";
import type { OpenDocument } from "@/client/stores";
import { changeListLabel } from "@/features/draft-review/DocumentChanges";
import type { DraftNotice } from "@/features/draft-review/draft-notices";
import { DiscardQuestion } from "@/features/draft-review/ReviewActions";
import {
  ReviewFailureNotices,
  ReviewStateInline,
} from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import type { ReviewHeaderModel } from "@/features/draft-review/useReviewHeader";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import { type ManuscriptState, ManuscriptStateSlot } from "@/features/editor/ManuscriptStateNotice";

export function MobileReviewHeader({
  projectId,
  document,
  header,
  manuscriptState,
  notice,
  onOpenList,
}: {
  projectId: string;
  document: OpenDocument;
  header: ReviewHeaderModel;
  /** What live did to this document; it takes the row's free end. */
  manuscriptState: ManuscriptState | null;
  notice: DraftNotice | null;
  onOpenList: () => void;
}) {
  const { controller, view, finished } = header;
  // The stepper walks the text changes; a pending move or delete is listed, not stepped to.
  const count = view.items.filter(({ change }) => !change.tree).length;
  const stepping = view.status === "ready" && count > 0;
  return (
    <section
      aria-label={t`Draft review`}
      data-phone-review-header
      className="flex shrink-0 flex-col border-b border-border-subtle bg-review text-caption"
    >
      <div
        className="flex min-h-12 items-center gap-1"
        style={{
          paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
        }}
      >
        <div className="min-w-0">
          <DocumentVersionMenu
            projectId={projectId}
            document={document}
            touch
            review={{
              draftOnly: header.draftOnly,
              disabled: header.locked,
              onShowLive: header.showLive,
              draftCommands: finished
                ? undefined
                : {
                    canApply: header.canApply,
                    applying: header.completing === "apply",
                    onApply: header.applyDraft,
                    onDiscard: header.discardDraft,
                  },
              marks: { visible: controller.marksVisible, onChange: controller.setMarksVisible },
            }}
          />
        </div>
        {header.asking ? (
          <DiscardQuestion
            touch
            scope="document"
            className="flex-1"
            onKeep={header.keepDraft}
            onConfirm={header.confirmDiscard}
          />
        ) : (
          <ManuscriptStateSlot state={manuscriptState} notice={notice} touch />
        )}
        <ReviewStateInline
          touch
          finished={finished}
          completing={header.completing}
          next={header.next}
          draftOnly={header.draftOnly}
          onOpenNext={header.openDraft}
          onShowLive={header.showLive}
        />
        {stepping ? (
          <ReviewStepper
            touch
            count={count}
            focusedIndex={view.focusedIndex}
            disabled={false}
            onStep={view.step}
          />
        ) : null}
        <button
          type="button"
          disabled={finished || !!header.completing}
          aria-haspopup="dialog"
          aria-label={changeListLabel(view.items.length)}
          onClick={onOpenList}
          className="focus-ring flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-sm text-muted-foreground tabular-nums active:scale-[0.98]"
        >
          <List className="size-5" aria-hidden />
        </button>
      </div>
      <ReviewFailureNotices
        itemKey={view.itemKey ?? ""}
        commandError={header.commandError}
        failedElsewhere={header.failedElsewhere}
        onOpenNext={header.openDraft}
      />
    </section>
  );
}
