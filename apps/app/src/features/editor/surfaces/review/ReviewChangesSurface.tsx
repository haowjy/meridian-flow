/**
 * Binds the host's Review changes (`useReviewMode`) to its editor: turns the paint on and off,
 * presses a change from its margin pair, moves the focus to the next change after a press, and
 * closes Review changes when the chapter has none left (design §6, item 5). A press is a step of
 * the editor's Ctrl+Z: Undo sends the press's Undo, Redo presses again.
 */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { pushOutsideStep } from "@/core/editor/editor-history";
import {
  type ReviewChangesConfig,
  type ReviewVerdict,
  setReviewChanges,
} from "@/core/editor/extensions/review-changes/ReviewChangesExtension";
import type { ReviewRow } from "@/core/editor/extensions/review-changes/review-rows";
import { useOptionalDraftReview } from "@/features/draft-review/DraftReviewProvider";
import {
  publishReviewRows,
  useDraftPage,
  useReviewLayout,
  useReviewMode,
} from "@/features/draft-review/review-mode";

export function ReviewChangesSurface({ editor }: { editor: Editor }) {
  const mode = useReviewMode();
  const review = useOptionalDraftReview();
  const layout = useReviewLayout();
  // Pressed changes leave the page at once; the server's answer then takes them out of the copy.
  const [pressed, setPressed] = useState<ReadonlySet<string>>(new Set());
  const rows = useRef<readonly ReviewRow[] | null>(null);
  const latest = useRef({ mode, review, pressed });
  latest.current = { mode, review, pressed };
  const page = useDraftPage();
  const documentId = page?.documentId ?? null;
  const changeId = mode?.changeId ?? null;
  // A plain draft page reads the rows for its header's count; Review changes against Live paints
  // them. Another draft or file has no Apply or Discard.
  const active = page !== null;
  const reviewing = mode !== null && mode.target === "live";

  // Nothing to review closes onto the plain draft, once the list agrees the copy is not still
  // syncing the draft's changes in.
  const closeIfEmpty = () => {
    const { mode } = latest.current;
    const left = rows.current?.filter((row) => !latest.current.pressed.has(row.id));
    if (mode?.target === "live" && left?.length === 0 && mode.listed === false) mode.close();
  };
  useEffect(closeIfEmpty, [mode?.listed]);

  useEffect(() => {
    if (!active || !documentId || editor.isDestroyed) return;
    const shown = (all: readonly ReviewRow[]) =>
      all.filter((row) => !latest.current.pressed.has(row.id));
    const press = (verdict: ReviewVerdict, row: ReviewRow) => {
      const { mode, review } = latest.current;
      if (!mode || !review || review.controller.dispositionLocked) return;
      const ref = { documentId: mode.documentId, itemKey: mode.itemKey };
      const before = shown(rows.current ?? []);
      const index = before.findIndex((each) => each.id === row.id);
      const next = before[index + 1] ?? before[index - 1];
      setPressed((prior) => new Set(prior).add(row.id));
      // The writer stays in this chapter's editor, so Ctrl+Z still reaches the press.
      if (next) mode.focus(next.id);
      else mode.close();
      const send = () => review.controller.startChange(verdict, ref, row.id).outcome;
      void send().then((outcome) => {
        if (outcome.kind !== "done" || !outcome.undo) {
          setPressed((prior) => {
            const rest = new Set(prior);
            rest.delete(row.id);
            return rest;
          });
          return;
        }
        let undo = outcome.undo;
        if (editor.isDestroyed) return;
        pushOutsideStep(editor.state, {
          undo: () => void undo(),
          redo: () =>
            void send().then((again) => {
              if (again.kind === "done" && again.undo) undo = again.undo;
            }),
        });
      });
    };
    const config: ReviewChangesConfig = {
      layout: reviewing ? layout : "count",
      focus: changeId,
      hidden: pressed,
      labels: { apply: t`Apply`, discard: t`Discard`, restore: t`Restore` },
      press,
      focusRow: (row) => latest.current.mode?.focus(row.id),
      close: () => latest.current.mode?.close(),
      onRows: (all) => {
        rows.current = all;
        // A pressed change the copy no longer holds is settled.
        setPressed((prior) => {
          const ids = new Set(all.map((row) => row.id));
          const kept = new Set([...prior].filter((id) => ids.has(id)));
          return kept.size === prior.size ? prior : kept;
        });
        publishReviewRows(documentId, shown(all));
        settle();
      },
    };
    // Review changes opens at its `change`; one that no longer exists, or none, is the first.
    const settle = () => {
      const { mode } = latest.current;
      const left = shown(rows.current ?? []);
      closeIfEmpty();
      if (
        mode?.target === "live" &&
        left.length > 0 &&
        !left.some((row) => row.id === mode.changeId)
      )
        mode.focus(left[0].id);
    };
    setReviewChanges(editor.view, config);
    if (rows.current) {
      publishReviewRows(documentId, shown(rows.current));
      settle();
    }
  }, [active, reviewing, documentId, editor, layout, changeId, pressed]);

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
      publishReviewRows(documentId, null);
    };
  }, [documentId]);

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
