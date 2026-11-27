import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  type LinkHint as LinkHintTarget,
  linkTargetHref,
  linkTargetLabel,
} from "@/core/editor/links";
import {
  type AnchorRect,
  manuscriptOverlay,
  type OverlayBox,
  overlayViewport,
  useAnchorRect,
  useChromeSuppressed,
  useFadeHold,
} from "@/features/editor/chrome";

import { useLinkResolution } from "./useLinkResolution";

const HINT_GAP_PX = 6;
const HINT_MARGIN_PX = 8;

export function LinkHint({ editor, hint }: { editor: Editor; hint: LinkHintTarget | null }) {
  const suppressed = useChromeSuppressed(editor);
  const shown = useFadeHold(hint);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const rect = useAnchorRect(editor, shown?.element ?? null);
  const overlay = manuscriptOverlay(editor);
  const position = useHintPosition(element, rect, overlay);
  const visible = Boolean(hint) && !suppressed;
  const href = shown ? linkTargetHref(shown.target) : null;
  const resolution = useLinkResolution(editor, href ? { ref: shown?.ref ?? null, href } : null);

  if (!shown || !href || !rect || !overlay || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={setElement}
      data-link-hint
      data-state={visible ? "open" : "closed"}
      className="meridian-link-hint"
      style={position ?? { left: rect.left, top: rect.bottom + HINT_GAP_PX }}
    >
      <span className="meridian-link-hint__destination">
        {resolution?.state === "document"
          ? resolution.document.title
          : resolution?.state === "folder"
            ? resolution.folder.title
            : linkTargetLabel(shown.target)}
      </span>
      {resolution?.state === "document" ? (
        <span className="meridian-link-hint__note">{resolution.document.path}</span>
      ) : null}
      {resolution?.state === "missing" ? (
        <span className="meridian-link-hint__note">{t`Doesn't exist yet`}</span>
      ) : null}
      {resolution?.state === "gone" ? (
        <span className="meridian-link-hint__note">{t`No longer available`}</span>
      ) : null}
    </div>,
    overlay,
  );
}

function useHintPosition(
  hint: HTMLElement | null,
  rect: AnchorRect | null,
  overlay: HTMLElement | null,
): { left: number; top: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!hint || !rect || !overlay) {
      setPosition(null);
      return;
    }
    const box = hint.getBoundingClientRect();
    const seen: OverlayBox = overlayViewport(overlay);
    const left = Math.max(
      seen.left + HINT_MARGIN_PX,
      Math.min(rect.left, seen.right - box.width - HINT_MARGIN_PX),
    );
    const below = rect.bottom + HINT_GAP_PX;
    const fitsBelow = below + box.height + HINT_MARGIN_PX <= seen.bottom;
    const top = fitsBelow ? below : rect.top - box.height - HINT_GAP_PX;
    setPosition((previous) =>
      previous && previous.left === left && previous.top === top ? previous : { left, top },
    );
  }, [hint, rect, overlay]);

  return position;
}
