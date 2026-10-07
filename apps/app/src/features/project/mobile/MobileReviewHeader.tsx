/**
 * MobileReviewHeader — the phone's review chrome, one compact row under the top
 * bar: the draft switcher (`Chapter 12 ▼`), the stepper (`‹ 3 of 6 ›`) and the
 * change count that opens the list.
 *
 * Apply draft, Discard draft and Show changes live in the switcher's menu to
 * keep the row short; they are the commands the desktop header runs, from the
 * same `useReviewHeader` model. The row appears with the painted review, never
 * over the live text held until then (the caller gates it on `inlineReview.shown`).
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
  const { controller, view, finished, switcher } = header;
  const count = view.items.length;
  const ready = view.status === "ready" && count > 0;
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
            {...switcher}
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
        {ready ? (
          <>
            <ReviewStepper
              touch
              count={count}
              focusedIndex={view.focusedIndex}
              disabled={!controller.marksVisible}
              onStep={view.step}
            />
            <button
              type="button"
              aria-haspopup="dialog"
              aria-label={count === 1 ? t`Show the 1 change` : t`Show the ${count} changes`}
              onClick={onOpenList}
              className="focus-ring flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-sm text-muted-foreground tabular-nums active:scale-[0.98]"
            >
              <List className="size-5" aria-hidden />
              <span>{count}</span>
            </button>
          </>
        ) : null}
      </div>
      <ReviewHeaderNotices
        touch
        commandError={header.commandError}
        finished={finished}
        completing={header.completing}
        next={header.next}
        draftOnly={switcher.draftOnly}
        onOpenNext={switcher.onOpenDraft}
        onShowLive={header.showLive}
      />
    </section>
  );
}
