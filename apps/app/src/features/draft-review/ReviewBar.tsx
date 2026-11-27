import "./review-line.css";
import { t } from "@lingui/core/macro";
import { Columns2 } from "lucide-react";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import { IconButton } from "@/components/ui/icon-button";
import { usePanePlace } from "@/features/project/pane-place";
import { useItemLauncher } from "@/features/project/review-launch";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { holdFocus, lastInputWasKeyboard, moveFocus } from "@/lib/focus-follow";
import { noticeAction } from "./CommandNotice";
import { useOptionalDraftReview } from "./DraftReviewProvider";
import { ReviewActions } from "./ReviewActions";
import { ReviewStepper } from "./ReviewStepper";
import { ReviewTargetPicker } from "./ReviewTargetPicker";
import {
  landOnLast,
  setReviewLayout,
  useChosenReviewLayout,
  useReviewFitsSide,
  useReviewMode,
  useReviewRows,
} from "./review-mode";

export function ReviewBar() {
  const mode = useReviewMode();
  const review = useOptionalDraftReview();
  const layout = useChosenReviewLayout();
  const wide = useReviewFitsSide();
  const rows = useReviewRows() ?? [];
  const files = useOwnerDrafts(mode?.projectId ?? null, mode?.draftId ?? null).files ?? [];
  const { openReview } = useItemLauncher();
  const touch = useCoarsePointer();
  const pane = usePanePlace();
  if (!mode || !review) return null;
  const focused = rows.findIndex((row) => row.id === mode.changeId);
  const locked = review.controller.dispositionLocked;
  const ref = { documentId: mode.documentId, itemKey: mode.itemKey };
  const deleted = files.find((file) => file.documentId === mode.documentId)?.item.tree?.deleted;
  const live = mode.target === "live";
  const changed = live ? files.filter((file) => file.item.pending && file.contextLocation) : [];
  const here = changed.findIndex((file) => file.documentId === mode.documentId);
  const counted = (files: typeof changed) =>
    files.reduce(
      (sum, file) => (file.documentId === mode.documentId ? sum : sum + file.item.changeCount),
      0,
    );
  const before = here < 0 ? 0 : counted(changed.slice(0, here));
  const total = rows.length + counted(changed);
  const elsewhere = changed.some((file) => file.documentId !== mode.documentId);

  const step = (direction: 1 | -1) => {
    const next = focused + direction;
    if (next >= 0 && next < rows.length) return mode.focus(rows[next].id);
    const from = here >= 0 ? here : direction === 1 ? -1 : changed.length;
    const file = changed.at((from + direction + changed.length) % changed.length);
    if (!file?.contextLocation || file.documentId === mode.documentId) {
      if (rows.length > 0) mode.focus(rows[direction === 1 ? 0 : rows.length - 1].id);
      return;
    }
    if (direction === -1) landOnLast(pane, file.documentId);
    openReview({
      draftId: mode.draftId,
      documentId: file.documentId,
      itemKey: file.item.itemKey,
      contextLocation: file.contextLocation,
      documentName: file.documentName ?? undefined,
      draftOnly: file.draftOnly,
      replace: true,
    });
  };
  const pressChapter = (verdict: "apply" | "discard", event: { currentTarget: HTMLElement }) => {
    // The pressed control leaves with the bar: the focus waits for the notice's Undo.
    const page = event.currentTarget.closest<HTMLElement>("[data-paint-frame]");
    if (page)
      holdFocus(
        () => pageNoticeAction(page),
        undefined,
        (element) => moveFocus(element, { ring: lastInputWasKeyboard() }),
      );
    mode.close();
    void review.controller.pressDocument(verdict, ref);
  };

  return (
    <div
      ref={fitReviewLine}
      data-review-line
      data-review-bar={mode.documentId}
      className="flex min-w-0 flex-1 items-center gap-1.5"
    >
      <ReviewTargetPicker mode={mode} />
      {wide ? (
        <IconButton
          size="xs"
          variant="quiet"
          label={layout === "side" ? t`Show inline` : t`Show side by side`}
          aria-pressed={layout === "side"}
          onClick={() => setReviewLayout(layout === "side" ? "inline" : "side")}
        >
          <Columns2 aria-hidden />
        </IconButton>
      ) : null}
      <span data-review-end className="ml-auto flex shrink-0 items-center gap-1.5">
        <span data-review-secondary className="contents">
          <ReviewStepper
            count={total}
            crosses={elsewhere}
            focusedIndex={focused < 0 ? -1 : before + focused}
            disabled={total === 0}
            onStep={step}
            touch={touch}
          />
        </span>
        {live ? (
          <ReviewActions
            scope="document"
            labels={{
              discard: deleted ? t`Restore this chapter` : t`Discard this chapter`,
              apply: t`Apply this chapter`,
            }}
            words={deleted ? { discard: t`Restore` } : undefined}
            density="icon"
            touch={touch}
            disabled={locked}
            onDiscard={(event) => pressChapter("discard", event)}
            onApply={(event) => pressChapter("apply", event)}
          />
        ) : null}
      </span>
    </div>
  );
}

function fitReviewLine(line: HTMLDivElement | null) {
  if (!line) return;
  // The target picker's name shrinks before anything overflows, so a cut name gives the count's
  // room to the name; only an overflow hides the stepper, never a long name.
  const fits = (level: number) =>
    line.scrollWidth <= line.clientWidth &&
    (level >= 2 ||
      [...line.querySelectorAll<HTMLElement>(".truncate")].every(
        (label) => label.scrollWidth <= label.clientWidth,
      ));
  const fit = () => {
    for (let level = 0; level <= 3; level++) {
      line.dataset.collapse = String(level);
      if (fits(level)) break;
    }
  };
  fit();
  const resize = new ResizeObserver(fit);
  resize.observe(line);
  const mutations = new MutationObserver(fit);
  mutations.observe(line, { childList: true, subtree: true, characterData: true });
  return () => {
    resize.disconnect();
    mutations.disconnect();
  };
}

const pageNoticeAction = (page: HTMLElement) => {
  const foot = page.querySelector<HTMLElement>("[data-page-notice]");
  return foot ? noticeAction(foot) : null;
};
