/**
 * The review's entry in the chrome host: a compact bar beside the change the
 * writer is looking at, with the chat that wrote it, Discard and Apply.
 *
 * The change is a decoration, and the plugin rebuilds every decoration on each
 * refetch and remote write, so the element is looked up again after each
 * transaction rather than held. The bar is portalled into the manuscript's
 * scroll pane and placed in its coordinates (`manuscript-overlay`), so a scroll
 * carries it with the text and the pane clips it at its edge.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getInlineReviewPluginState } from "@/core/editor/extensions/inline-review";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { ReviewChangeBar } from "@/features/draft-review/ReviewChangeBar";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { escapeCssIdent } from "@/lib/css-selector";
import type { EditorChromeSurfaceProps } from "../../chrome";
import { manuscriptOverlay, overlayViewport } from "../../chrome/manuscript-overlay";
import { useAnchorRect } from "../../chrome/useAnchorRect";

/** Room the bar needs above a change before it flips below the line instead. */
const FLIP_ABOVE_PX = 44;
const GAP_PX = 8;

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
  const overlay = manuscriptOverlay(editor);

  if (!reviewing || !controller.marksVisible || !focusedItem || !rect || !overlay) return null;

  const viewport = overlayViewport(overlay);
  const above = rect.top - viewport.top >= FLIP_ABOVE_PX;
  // Anchor to whichever edge keeps the bar inside the page: it grows away from it.
  const toEnd = rect.left > overlay.clientWidth * 0.55;
  return createPortal(
    <div
      className="absolute z-30"
      style={{
        top: above ? rect.top - GAP_PX : rect.bottom + GAP_PX,
        transform: above ? "translateY(-100%)" : undefined,
        ...(toEnd
          ? { right: Math.max(GAP_PX, overlay.clientWidth - rect.right) }
          : { left: Math.max(GAP_PX, rect.left) }),
        maxWidth: `calc(100% - ${2 * GAP_PX}px)`,
      }}
    >
      <ReviewChangeBar
        change={focusedItem.change}
        disabled={view.locked}
        canApply={view.canApply}
        failure={focusedItem.failure}
        onApply={() => void view.apply(focusedItem.change)}
        onDiscard={() => void view.discard(focusedItem.change)}
      />
    </div>,
    overlay,
  );
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
