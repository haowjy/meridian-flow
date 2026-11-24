/**
 * Binds the host's Review changes (`useReviewMode`) to its editor: turns the paint on and off,
 * presses a change from its margin pair (or takes another draft's paragraph), moves the focus to
 * the next change after a press, and closes Review changes against Live when the chapter has none
 * left, and compares against Live when its target is gone.
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { useProjectTrees } from "@/client/query/useProjectTrees";
import {
  type ReviewChangesConfig,
  type ReviewVerdict,
  setReviewChanges,
  takeRow,
} from "@/core/editor/extensions/review-changes/ReviewChangesExtension";
import type { ReviewRow } from "@/core/editor/extensions/review-changes/review-rows";
import { useOptionalDraftReview } from "@/features/draft-review/DraftReviewProvider";
import {
  landed,
  landingOf,
  useDraftPage,
  useReviewLayout,
  useReviewMode,
  useReviewSurface,
} from "@/features/draft-review/review-mode";
import { referenceOf, useReviewReference } from "@/features/draft-review/use-review-reference";
import { usePanePlace } from "@/features/project/pane-place";
import { useShellTreeVersion } from "@/features/project/tree-version";

/**
 * The editor's width at which Review changes offers two columns: one side panel open beside a
 * 1280px window fits them, both open falls back to Inline.
 */
const SIDE_BY_SIDE_MIN_PX = 680;

export function ReviewChangesSurface({ editor }: { editor: Editor }) {
  const mode = useReviewMode();
  const review = useOptionalDraftReview();
  const layout = useReviewLayout();
  const surface = useReviewSurface();
  const pane = usePanePlace();
  // Pressed changes leave the page at once; the server's answer then takes them out of the copy.
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const rows = useRef<readonly ReviewRow[] | null>(null);
  const latest = useRef({ mode, review, pressed });
  latest.current = { mode, review, pressed };
  const page = useDraftPage();
  const documentId = page?.documentId ?? null;
  const draftId = page?.draftId ?? null;
  const target = mode?.target ?? "live";
  const changeId = mode?.changeId ?? null;
  // A plain draft page reads the rows against Live for its header's count; Review changes paints
  // them against its target.
  const active = page !== null;
  const reviewing = mode !== null;
  const reference = useReviewReference(mode);
  const against = reference?.kind ?? "live";
  const referenceDocs = reference && reference.kind !== "live" ? reference.docs : null;

  // Nothing to review closes onto the plain draft, once the list agrees the copy is not still
  // syncing the draft's changes in.
  const closeIfEmpty = () => {
    const { mode } = latest.current;
    const left = rows.current?.filter((row) => !latest.current.pressed.has(row.id));
    if (mode?.target === "live" && left?.length === 0 && mode.listed === false) mode.close();
  };
  useEffect(closeIfEmpty, [mode?.listed]);

  // A target that is gone (a deleted draft, a file no longer in the project) compares against Live.
  const gone = useTargetGone(mode);
  useEffect(() => {
    if (gone) latest.current.mode?.retarget("live");
  }, [gone]);

  useEffect(() => {
    if (!active || !documentId || !draftId || editor.isDestroyed) return;
    const shown = (all: readonly ReviewRow[]) =>
      all.filter((row) => !latest.current.pressed.has(row.id));
    const nextAfter = (row: ReviewRow) => {
      const before = shown(rows.current ?? []);
      const index = before.findIndex((each) => each.id === row.id);
      return before[index + 1] ?? before[index - 1];
    };
    const press = (verdict: ReviewVerdict, row: ReviewRow) => {
      const { mode, review } = latest.current;
      if (!mode || !review || review.controller.dispositionLocked) return;
      const ref = { documentId: mode.documentId, itemKey: mode.itemKey };
      const next = nextAfter(row);
      setPressed((prior) => new Set(prior).add(row.id));
      // The writer stays in this chapter's editor, so Ctrl+Z still reaches the press.
      if (next) mode.focus(next.id);
      else mode.close();
      void review.controller.pressChange(verdict, ref, row.id).then((outcome) => {
        if (outcome === "done") return;
        setPressed((prior) => {
          const rest = new Set(prior);
          rest.delete(row.id);
          return rest;
        });
      });
    };
    const config: ReviewChangesConfig = {
      layout: reviewing ? layout : "count",
      against,
      target,
      reference: referenceDocs,
      draftId,
      focus: changeId,
      hidden: pressed,
      labels: {
        apply: t`Apply`,
        discard: t`Discard`,
        restore: t`Restore`,
        take: t`Take`,
        moved: t`Moved`,
        restyled: t`Style`,
        comment: t`Comment`,
        image: t`Image`,
      },
      press,
      take: (row) => {
        if (editor.isDestroyed) return;
        const next = nextAfter(row);
        takeRow(editor.view, row, draftId);
        // As after a press: on to the next difference, the caret in the text so Ctrl+Z reaches the Take.
        if (next) latest.current.mode?.focus(next.id);
        editor.view.focus();
      },
      focusRow: (row) => latest.current.mode?.focus(row.id),
      onRows: (all) => {
        rows.current = all;
        // A pressed change the copy no longer holds is settled.
        setPressed((prior) => {
          const ids = new Set(all.map((row) => row.id));
          const kept = new Set([...prior].filter((id) => ids.has(id)));
          return kept.size === prior.size ? prior : kept;
        });
        surface?.publishRows(shown(all));
        settle();
      },
    };
    // Review changes opens at its `change`, named by any of its members (a turn card names the
    // first block the turn changed); one that no longer exists, or none, is the first (the last
    // after a step back from the next chapter).
    const settle = () => {
      const { mode } = latest.current;
      const left = shown(rows.current ?? []);
      closeIfEmpty();
      if (!mode || left.length === 0) return;
      if (left.some((row) => row.id === mode.changeId)) return landed(pane, mode.documentId);
      const named = mode.changeId
        ? left.find((row) => row.members?.includes(mode.changeId ?? ""))
        : undefined;
      const landing =
        named ?? (landingOf(pane, mode.documentId) === "last" ? left.at(-1) : left[0]);
      if (landing) mode.focus(landing.id);
    };
    setReviewChanges(editor.view, config);
    if (rows.current) {
      surface?.publishRows(shown(rows.current));
      settle();
    }
  }, [
    active,
    reviewing,
    against,
    target,
    referenceDocs,
    documentId,
    draftId,
    editor,
    layout,
    changeId,
    pressed,
    surface,
    pane,
  ]);

  useEffect(() => {
    if (!active || editor.isDestroyed) return;
    return () => {
      rows.current = null;
      if (!editor.isDestroyed) setReviewChanges(editor.view, null);
    };
  }, [active, editor]);

  useEffect(() => {
    if (!documentId) return;
    return () => {
      rows.current = null;
      surface?.publishRows(null);
    };
  }, [documentId, surface]);

  useEffect(() => {
    if (!surface || editor.isDestroyed) return;
    const dom = editor.view.dom;
    const measure = () => surface.setWide(dom.clientWidth >= SIDE_BY_SIDE_MIN_PX);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(dom);
    return () => resize.disconnect();
  }, [editor, surface]);

  // The focused change comes into view: a step, a press's next change, a link's `change`.
  const focus = reviewing ? changeId : null;
  useEffect(() => {
    if (!focus || editor.isDestroyed) return;
    const frame = requestAnimationFrame(() => {
      const element = editor.view.dom.querySelector(`[data-review-row="${CSS.escape(focus)}"]`);
      element?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, focus]);
  return null;
}

function useTargetGone(mode: ReturnType<typeof useReviewMode>): boolean {
  const drafts = useShellTreeVersion()?.workDrafts?.drafts ?? null;
  const trees = useProjectTrees(mode?.projectId ?? "");
  if (!mode) return false;
  const target = referenceOf(mode.target);
  if (target.kind === "file") return trees.isComplete && trees.find(target.documentId) === null;
  // Only a draft of the shown Work knows its sibling drafts.
  return (
    target.kind === "draft" &&
    drafts !== null &&
    drafts.some((draft) => draft.id === mode.draftId) &&
    !drafts.some((draft) => draft.id === target.draftId)
  );
}
