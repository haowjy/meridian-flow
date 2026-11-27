import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
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

const SIDE_BY_SIDE_MIN_PX = 680;

export function ReviewChangesSurface({ editor }: { editor: Editor }) {
  const mode = useReviewMode();
  const review = useOptionalDraftReview();
  const ownerRevision = useSyncExternalStore(
    review?.controller.owner.subscribe ?? noSubscription,
    review?.controller.owner.snapshot ?? zeroSnapshot,
    zeroSnapshot,
  );
  const layout = useReviewLayout();
  const surface = useReviewSurface();
  const pane = usePanePlace();
  const rows = useRef<readonly ReviewRow[] | null>(null);
  const latest = useRef({ mode, review });
  latest.current = { mode, review };
  const page = useDraftPage();
  const documentId = page?.documentId ?? null;
  const draftId = page?.draftId ?? null;
  const target = mode?.target ?? "live";
  const changeId = mode?.changeId ?? null;
  const hidden = useMemo(
    () => review?.controller.owner.heldChanges(mode?.itemKey ?? "") ?? new Set<string>(),
    [review, mode?.itemKey, ownerRevision],
  );
  const active = page !== null;
  const reviewing = mode !== null;
  const reference = useReviewReference(mode);
  const against = reference?.kind ?? "live";
  const referenceDocs = reference && reference.kind !== "live" ? reference.docs : null;

  const closeIfEmpty = () => {
    const { mode } = latest.current;
    const left = rows.current?.filter((row) => !hidden.has(row.id));
    if (mode?.target === "live" && left?.length === 0 && mode.listed === false) mode.close();
  };
  useEffect(closeIfEmpty, [mode?.listed]);

  const gone = useTargetGone(mode);
  useEffect(() => {
    if (gone) latest.current.mode?.retarget("live");
  }, [gone]);

  useEffect(() => {
    if (!active || !documentId || !draftId || editor.isDestroyed) return;
    const nextAfter = (row: ReviewRow) => {
      const before = (rows.current ?? []).filter((each) => !hidden.has(each.id));
      const index = before.findIndex((each) => each.id === row.id);
      return before[index + 1] ?? before[index - 1];
    };
    const press = (verdict: ReviewVerdict, row: ReviewRow) => {
      const { mode, review } = latest.current;
      if (!mode || !review || review.controller.dispositionLocked) return;
      const ref = { documentId: mode.documentId, itemKey: mode.itemKey };
      const next = nextAfter(row);
      if (next) mode.focus(next.id);
      else mode.close();
      void review.controller.pressChange(verdict, ref, row.id);
    };
    const config: ReviewChangesConfig = {
      layout: reviewing ? layout : "count",
      against,
      target,
      reference: referenceDocs,
      draftId,
      focus: changeId,
      hidden,
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
        if (next) latest.current.mode?.focus(next.id);
        editor.view.focus();
      },
      focusRow: (row) => latest.current.mode?.focus(row.id),
      onRows: (all) => {
        rows.current = all;
        surface?.publishRows(all.filter((row) => !hidden.has(row.id)));
        settle();
      },
    };
    const settle = () => {
      const { mode } = latest.current;
      const left = (rows.current ?? []).filter((row) => !hidden.has(row.id));
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
      surface?.publishRows(rows.current.filter((row) => !hidden.has(row.id)));
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
    hidden,
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

const noSubscription = () => () => {};
const zeroSnapshot = () => 0;

function useTargetGone(mode: ReturnType<typeof useReviewMode>): boolean {
  const drafts = useShellTreeVersion()?.workDrafts?.drafts ?? null;
  const trees = useProjectTrees(mode?.projectId ?? "");
  if (!mode) return false;
  const target = referenceOf(mode.target);
  if (target.kind === "file") return trees.isComplete && trees.find(target.documentId) === null;
  return (
    target.kind === "draft" &&
    drafts !== null &&
    drafts.some((draft) => draft.id === mode.draftId) &&
    !drafts.some((draft) => draft.id === target.draftId)
  );
}
