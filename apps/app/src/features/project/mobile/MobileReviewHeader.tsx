/**
 * MobileReviewHeader — the phone's review chrome, one compact row under the top
 * bar: the draft switcher (`Chapter 12 ▼`), the stepper (`‹ 3 of 6 ›`) and the
 * list button, with the change count when there are changes.
 *
 * Apply draft, Discard draft and Show changes live in the switcher's menu to
 * keep the row short; they are the commands the desktop header runs, from the
 * same `useReviewHeader` model. The row appears with the painted review, never
 * over the live text held until then (the caller gates it on `inlineReview.shown`).
 *
 * The list button is the way to the Work's draft files and Apply all, so it
 * stays while the row shows: the open file is always in that list, even with no
 * change left to step through (formatting only, or just finished). Only the
 * stepper depends on the change count.
 */
import { t } from "@lingui/core/macro";
import { List } from "lucide-react";

import { DraftSwitcher } from "@/features/draft-review/DraftSwitcher";
import { ReviewHeaderNotices } from "@/features/draft-review/ReviewHeaderNotices";
import { ReviewStepper } from "@/features/draft-review/ReviewStepper";
import type { ReviewHeaderModel } from "@/features/draft-review/useReviewHeader";

export function MobileReviewHeader({
  header,
  onOpenList,
}: {
  header: ReviewHeaderModel;
  onOpenList: () => void;
}) {
  const { controller, view, finished } = header;
  const count = view.items.length;
  const stepping = view.status === "ready" && count > 0;
  return (
    <section
      aria-label={t`Draft review`}
      data-phone-review-header
      className="flex shrink-0 flex-col border-b border-border-subtle bg-dock-surface text-caption"
    >
      <div
        className="flex min-h-12 items-center gap-1"
        style={{
          paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
        }}
      >
        <div className="min-w-0 flex-1">
          <DraftSwitcher
            draftOnly={header.draftOnly}
            disabled={header.locked}
            onShowLive={header.showLive}
            touch
            draftCommands={
              finished
                ? undefined
                : {
                    canApply: controller.canApplyReviewedDraft,
                    applying: controller.isApplying,
                    onApply: header.applyDraft,
                    onDiscard: header.discardDraft,
                  }
            }
            marks={{ visible: controller.marksVisible, onChange: controller.setMarksVisible }}
          />
        </div>
        {stepping ? (
          <ReviewStepper
            touch
            count={count}
            focusedIndex={view.focusedIndex}
            disabled={!controller.marksVisible}
            onStep={view.step}
          />
        ) : null}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={
            count === 0
              ? t`Show the draft files`
              : count === 1
                ? t`Show the 1 change`
                : t`Show the ${count} changes`
          }
          onClick={onOpenList}
          className="focus-ring flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-sm text-muted-foreground tabular-nums active:scale-[0.98]"
        >
          <List className="size-5" aria-hidden />
          {count > 0 ? <span>{count}</span> : null}
        </button>
      </div>
      <ReviewHeaderNotices
        touch
        commandError={header.commandError}
        failedElsewhere={header.failedElsewhere}
        finished={finished}
        unlisted={header.unlisted}
        completing={header.completing}
        next={header.next}
        draftOnly={header.draftOnly}
        onOpenNext={header.openDraft}
        onShowLive={header.showLive}
      />
    </section>
  );
}
