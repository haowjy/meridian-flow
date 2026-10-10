/**
 * The review's entry in the chrome host: a compact bar beside the change the
 * writer is looking at, with the chat that wrote it, Discard and Apply.
 *
 * The bar never covers manuscript text (`place-review-bar`). With room in the
 * right margin it is portalled into the manuscript's scroll pane beside the
 * change's first line, so a scroll carries it with the text. Without room it
 * moves into a block the editor opens after the paragraph the change ends in
 * (`setInlineReviewBarSlot`), which pushes the text below it down.
 *
 * The change is a decoration, and the plugin rebuilds every decoration on each
 * refetch and remote write, so its element (and the slot) is looked up again
 * after each transaction rather than held.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BAR_SLOT_ATTR, getInlineReviewPluginState } from "@/core/editor/extensions/inline-review";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewChangeBar } from "@/features/draft-review/ReviewChangeBar";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { escapeCssIdent } from "@/lib/css-selector";
import type { EditorChromeSurfaceProps } from "../../chrome";
import { manuscriptOverlay } from "../../chrome/manuscript-overlay";
import { useAnchorRect } from "../../chrome/useAnchorRect";
import { placeReviewBar } from "./place-review-bar";
import { useManuscriptColumn } from "./useManuscriptColumn";

export function ReviewChangeBarSurface({ editor }: EditorChromeSurfaceProps) {
  const { controller } = useDraftReview();
  const reviewing = !editor.isDestroyed && getInlineReviewPluginState(editor.state) !== null;
  const view = useReviewChanges(controller, { enabled: reviewing });
  const focusedItem = view.items.find((item) => item.change.classId === view.focused?.classId);
  const anchor = useChangeElement(
    editor,
    reviewing ? (focusedItem?.change.anchorOperationId ?? null) : null,
  );
  const rect = useAnchorRect(editor, anchor);
  const column = useManuscriptColumn(editor, reviewing);
  const overlay = manuscriptOverlay(editor);
  // A phone's bar is pinned to the bottom of the screen (`MobileChangeBar`).
  const phone = usePhoneShell();

  const showing =
    !phone && reviewing && controller.marksVisible && Boolean(focusedItem) && Boolean(rect);
  const placement =
    showing && rect && column && focusedItem
      ? placeReviewBar({
          anchor: rect,
          ...column,
          includesWriterEdits: focusedItem.change.includesWriterEdits,
        })
      : null;
  const wantsSlot = placement?.kind === "below";
  const slot = useBarSlot(editor, wantsSlot);

  if (!focusedItem || !placement) return null;

  const bar = (
    <ReviewChangeBar
      change={focusedItem.change}
      disabled={view.locked}
      canApply={view.canApply}
      failure={focusedItem.failure}
      onApply={() => void view.apply(focusedItem.change)}
      onDiscard={() => void view.discard(focusedItem.change)}
    />
  );

  if (placement.kind === "below") return slot ? createPortal(bar, slot) : null;
  if (!overlay) return null;
  return createPortal(
    <div
      className="absolute z-30"
      style={{ top: placement.top, left: placement.left, width: placement.maxWidth }}
    >
      {bar}
    </div>,
    overlay,
  );
}

/**
 * Open the editor's bar block while `wanted`, and return its element. The block
 * is a decoration, so it is looked up again after each transaction.
 */
function useBarSlot(editor: Editor, wanted: boolean): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!wanted || editor.isDestroyed) {
      setSlot(null);
      return;
    }
    const find = () => {
      const found = editor.isDestroyed ? null : editor.view.dom.querySelector(`[${BAR_SLOT_ATTR}]`);
      setSlot(found instanceof HTMLElement ? found : null);
    };
    editor.commands.setInlineReviewBarSlot(true);
    find();
    // The transaction event fires once the view has the new DOM.
    editor.on("transaction", find);
    return () => {
      editor.off("transaction", find);
      if (!editor.isDestroyed) editor.commands.setInlineReviewBarSlot(false);
    };
  }, [editor, wanted]);

  return slot;
}

/**
 * The first element the editor draws for one operation. Decorations are rebuilt
 * on every model and remote write, so it is queried again after each
 * transaction; the state only changes when the element actually does.
 */
function useChangeElement(editor: Editor, operationId: string | null): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const selector = useMemo(
    () => (operationId ? `[data-review-operations~="${escapeCssIdent(operationId)}"]` : null),
    [operationId],
  );

  useLayoutEffect(() => {
    if (!selector) {
      setElement(null);
      return;
    }
    const find = () => {
      const found = editor.isDestroyed ? null : editor.view.dom.querySelector(selector);
      setElement(found instanceof HTMLElement ? found : null);
    };
    find();
    let frame = 0;
    const onTransaction = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(find);
    };
    editor.on("transaction", onTransaction);
    return () => {
      cancelAnimationFrame(frame);
      editor.off("transaction", onTransaction);
    };
  }, [editor, selector]);

  // The model can arrive before the first decoration paints.
  useEffect(() => {
    if (element || !selector) return;
    const timer = window.setTimeout(() => {
      const found = editor.isDestroyed ? null : editor.view.dom.querySelector(selector);
      if (found instanceof HTMLElement) setElement(found);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [editor, element, selector]);

  return element;
}
