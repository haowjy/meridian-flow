/**
 * MobileChangeBar — the selected change's controls, pinned to the bottom of the
 * manuscript on a phone: who wrote it, "Includes your edits", Discard, Apply.
 * It is in the page's flow (the manuscript shrinks to make room), so nothing is
 * ever hidden behind it, and it clears the home indicator, or the on-screen
 * keyboard when that is up (`--mobile-keyboard-height`, set by
 * `MobileKeyboardAware`). Tapping a change selects it; nothing here is hover.
 */
import { ReviewChangeBar } from "@/features/draft-review/ReviewChangeBar";
import type { ReviewChangesView } from "@/features/draft-review/useReviewChanges";

export function MobileChangeBar({ view }: { view: ReviewChangesView }) {
  const item = view.items.find((candidate) => candidate.change.classId === view.focused?.classId);
  if (!item) return null;
  const { change, failure } = item;
  return (
    <div
      data-phone-change-bar
      className="shrink-0 bg-background px-2 pt-1.5 animate-in fade-in-0 slide-in-from-bottom-2 duration-150 motion-reduce:animate-none"
      style={{
        paddingBottom:
          "max(0.5rem, env(safe-area-inset-bottom), var(--mobile-keyboard-height, 0px))",
        paddingLeft: "max(0.5rem, env(safe-area-inset-left))",
        paddingRight: "max(0.5rem, env(safe-area-inset-right))",
      }}
    >
      <ReviewChangeBar
        touch
        change={change}
        disabled={view.locked}
        canApply={view.canApply}
        failure={failure}
        onApply={() => void view.apply(change)}
        onDiscard={() => void view.discard(change)}
        className="rounded-xl"
      />
    </div>
  );
}
