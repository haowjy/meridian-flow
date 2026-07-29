/**
 * OverlayIconRow — an object's verbs, overlaid just inside its top-right
 * bounds (ruling 8; mockup 03b is the decision record).
 *
 * Zero footprint is the whole point: no band above the object, no reserved
 * space, no layout growth, nothing that moves a line of the manuscript when it
 * appears. So the row is portalled and positioned from the object's measured
 * rect rather than rendered inside the node — a node view that laid it out
 * would have to reserve space for it, and the ruling is that it must not.
 *
 * Each button is its own compact rounded-square card chip so it reads over
 * diagram lines, with its label in a tooltip and the row ending in ⋮. The
 * occlusion trade is accepted (the human's "literally basically inside the
 * diagram").
 *
 * Approach chrome, not an active surface: `anchor` says which object is being
 * approached, `visible` fades the row in and out over it, and the kernel
 * suppresses the whole thing while the writer drags or sweeps. Fading rather
 * than unmounting is deliberate — a row that vanishes on the frame the pointer
 * leaves reads as a flicker, and the design asks for a fade both ways.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { MoreVertical } from "lucide-react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { useAnchorRect } from "./useAnchorRect";
import { useChromeSuppressed } from "./useEditorChrome";

/** Matches mockup 03b: the row sits inside the bounds, not on the edge. */
const OVERLAY_INSET_PX = 10;

export type OverlayIconRowItem = {
  id: string;
  /** Writer-facing; the button is icon-only so this is its whole name. */
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

export type OverlayIconRowProps = {
  editor: Editor | null;
  /**
   * The object's rendered element. Null when no object is being approached —
   * that, not `visible`, is what takes the row out of the document.
   */
  anchor: HTMLElement | null;
  /** Hover settled on it, or its object is selected. Drives the fade. */
  visible: boolean;
  items: readonly OverlayIconRowItem[];
  /**
   * The ⋮ menu that ends the row, given the chip to use as its trigger. The
   * menu's items differ per object so they belong to the lane; the chip stays
   * the row's, so every object's overflow looks the same.
   */
  overflow?: (chip: ReactNode) => ReactNode;
  /** Names the row for probes and tests, e.g. `"diagram"`. */
  kind: string;
};

export function OverlayIconRow({
  editor,
  anchor,
  visible,
  items,
  overflow,
  kind,
}: OverlayIconRowProps) {
  const suppressed = useChromeSuppressed(editor);
  const rect = useAnchorRect(anchor);

  if (!anchor || !rect || typeof document === "undefined") return null;

  return createPortal(
    <TooltipProvider delayDuration={400}>
      <div
        data-overlay-icon-row={kind}
        data-editor-chrome
        data-state={visible && !suppressed ? "open" : "closed"}
        className="meridian-overlay-icon-row"
        style={{
          top: rect.top + OVERLAY_INSET_PX,
          // Anchored to the right edge so a row that gains a verb keeps its
          // outermost chip where the pointer already learned to find it.
          left: rect.right - OVERLAY_INSET_PX,
        }}
      >
        {items.map((item) => (
          <OverlayIconChip key={item.id} label={item.label} onSelect={item.onSelect}>
            {item.icon}
          </OverlayIconChip>
        ))}
        {overflow?.(
          <OverlayIconChip label={t`More`} asTrigger>
            <MoreVertical aria-hidden />
          </OverlayIconChip>,
        )}
      </div>
    </TooltipProvider>,
    document.body,
  );
}

function OverlayIconChip({
  label,
  onSelect,
  asTrigger = false,
  children,
}: {
  label: string;
  onSelect?: () => void;
  /** The ⋮ chip is a menu trigger, so the lane's menu owns its press. */
  asTrigger?: boolean;
  children: ReactNode;
}) {
  const chip = (
    <IconButton
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      className="meridian-overlay-icon-chip"
      onClick={asTrigger ? undefined : onSelect}
      // A press on the chrome must not move the caret out from under the
      // object the chrome belongs to.
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </IconButton>
  );

  if (asTrigger) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}
