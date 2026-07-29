/**
 * The destination hint: what this link goes to, shown on approach.
 *
 * Ruled with the click (ruling 4): a click follows the link, so hover has to
 * say where before it does. Approach chrome, not a surface (law 7) — it takes
 * no focus, claims no layer, and never blocks the words under it, so it hangs
 * below the link's left edge and lets pointer events pass through.
 *
 * It fades rather than vanishing. The store nulls the hint after the kernel's
 * leave grace, and unmounting on that frame would read as a blink, so the last
 * link stays rendered at zero opacity for the fade duration.
 *
 * An internal link says two things: where it goes, and — when nothing is there
 * yet — that nothing is there yet. The second line is a sentence rather than a
 * warning, because linking a chapter before writing it is how serial writers
 * work (§5.5). While the answer is still in flight it says only the
 * destination: a hint that guessed "not written" and corrected itself a moment
 * later would be worse than one that waited.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

import { type LinkHint as LinkHintTarget, linkTargetHref } from "@/core/editor/links";
import {
  type AnchorRect,
  useAnchorRect,
  useChromeSuppressed,
  useFadeHold,
} from "@/features/editor/chrome";

import { useLinkResolution } from "./useLinkResolution";

/** Below the link's baseline, clear of the descenders and the underline. */
const HINT_GAP_PX = 6;
/** How close to the viewport edge the hint may sit before it slides back in. */
const HINT_MARGIN_PX = 8;

export function LinkHint({ editor, hint }: { editor: Editor; hint: LinkHintTarget | null }) {
  const suppressed = useChromeSuppressed(editor);
  // Held one fade past its own disappearance, so the hint fades where it stood.
  const shown = useFadeHold(hint);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const rect = useAnchorRect(editor, shown?.element ?? null);
  const position = useHintPosition(element, rect);
  const visible = Boolean(hint) && !suppressed;
  const href = shown ? linkTargetHref(shown.target) : null;
  const resolution = useLinkResolution(editor, href);

  if (!shown || !href || !rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={setElement}
      data-link-hint
      data-state={visible ? "open" : "closed"}
      className="meridian-link-hint"
      style={position ?? { left: rect.left, top: rect.bottom + HINT_GAP_PX }}
    >
      <span className="meridian-link-hint__destination">
        {resolution?.state === "resolved" ? resolution.document.uri : href}
      </span>
      {resolution?.state === "unresolved" ? (
        <span className="meridian-link-hint__note">{t`No document with this name yet`}</span>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * Below the link, inside the viewport. A destination is as long as the writer's
 * URL, and a link near the right edge or the last line of the pane would put
 * the hint somewhere it cannot be read — so it slides back in, and flips above
 * the link when there is no room under it.
 *
 * Measured in a layout effect, which runs before paint: the correction is not a
 * frame the writer can see.
 */
function useHintPosition(
  hint: HTMLElement | null,
  rect: AnchorRect | null,
): { left: number; top: number } | null {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!hint || !rect) {
      setPosition(null);
      return;
    }
    const box = hint.getBoundingClientRect();
    const left = Math.max(
      HINT_MARGIN_PX,
      Math.min(rect.left, window.innerWidth - box.width - HINT_MARGIN_PX),
    );
    const below = rect.bottom + HINT_GAP_PX;
    const fitsBelow = below + box.height + HINT_MARGIN_PX <= window.innerHeight;
    const top = fitsBelow ? below : rect.top - box.height - HINT_GAP_PX;
    setPosition((previous) =>
      previous && previous.left === left && previous.top === top ? previous : { left, top },
    );
  }, [hint, rect]);

  return position;
}
