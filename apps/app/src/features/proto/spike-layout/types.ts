/**
 * Types for the stable-identity layout spike — surfaces are mounted ONCE
 * (react-reverse-portal InPortal) and OutPortal'd into CSS-grid named slots.
 * Moving a surface = a state change (reassign its slot), never a remount.
 *
 * THROWAWAY: this proves the architecture is viable; production rewrite later.
 */

/** Logical identity of every persistent surface in the spike. */
export type SurfaceId = "editor" | "chat" | "rail";

/** Named CSS-grid slot a surface can be placed into. */
export type SlotId =
  | "left"
  | "center"
  | "right"
  | "dock-right"
  | "rail-top"
  | "rail-bottom"
  | "hidden";

/** "Mode" of the project — drives which slots each surface lives in. */
export type ProjectMode = "context" | "chat";
