/**
 * Where an object's overlay chrome sits: just inside the object's top-right
 * bounds (ruling 8, mockup 03b).
 *
 * The object row and the code fence's chip cluster are different shapes over
 * the same corner, so the corner is defined once here and worn by both:
 * `.meridian-object-overlay` fixes and fades them, this decides where.
 */

import type { CSSProperties } from "react";

import type { AnchorRect } from "./useAnchorRect";
import "./object-overlay.css";

/** Matches mockup 03b: the overlay sits inside the bounds, not on the edge. */
const OVERLAY_INSET_PX = 10;

/**
 * Anchored to the right edge so an overlay that gains a verb keeps its
 * outermost control where the pointer already learned to find it. The class
 * supplies the `translateX(-100%)` that pulls it back over its own width.
 */
export function objectOverlayStyle(rect: AnchorRect): CSSProperties {
  return { top: rect.top + OVERLAY_INSET_PX, left: rect.right - OVERLAY_INSET_PX };
}
