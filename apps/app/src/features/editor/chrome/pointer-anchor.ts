/**
 * The element `EditorMenu` hangs off when it was summoned by a place rather
 * than a control.
 *
 * Radix positions against a real element, and a right-click has none — the
 * writer aimed at a word, not a button. This is that element: fixed at the
 * pointer, with no hit area. Radix's `DropdownMenu` has no Anchor
 * part, which is the only reason it exists: `EditorPopover` does have one and
 * measures a virtual reference instead, so an anchor that moves costs it
 * nothing.
 *
 * Inline style, not utility classes. The position is geometry, not theme, and
 * a utility layer that failed to reach this element would silently drop every
 * claimed menu in the top-left corner of the page.
 */

import type { CSSProperties } from "react";

export function pointerAnchorStyle(at: { x: number; y: number } | null): CSSProperties {
  return {
    position: "fixed",
    // Not zero: floating-ui follows an anchor's moves only when it has a size,
    // and a menu whose anchor moves must move with it.
    width: 1,
    height: 1,
    pointerEvents: "none",
    left: at?.x ?? 0,
    top: at?.y ?? 0,
  };
}
