// @ts-nocheck
/**
 * Spike workbench state — which logical surface lives in which grid slot, and
 * the workbench "mode" (context vs. chat) that switches the assignment table.
 *
 * Key decision: surface → slot is a pure data assignment. Components never
 * re-parent in React; the OutPortal does the DOM move. Toggling mode is what
 * triggers Motion `layout` animation on the slot containers.
 */
import { create } from "zustand";

import type { SlotId, SurfaceId, WorkbenchMode } from "./types";

type SpikeState = {
  mode: WorkbenchMode;
  /** Surface → slot assignment (the single source of truth for placement). */
  assignment: Record<SurfaceId, SlotId>;
  setMode: (mode: WorkbenchMode) => void;
  toggleMode: () => void;
  /** Reassign one surface — used by gate #1 (manual move test). */
  assign: (surface: SurfaceId, slot: SlotId) => void;
};

function assignmentFor(mode: WorkbenchMode): Record<SurfaceId, SlotId> {
  if (mode === "context") {
    // Context mode: editor center stage, chat docked, rail on top of rail column.
    return { editor: "center", chat: "dock-right", rail: "rail-top" };
  }
  // Chat mode: chat takes center; editor moves to dock-right (still mounted, same DOM node).
  return { editor: "dock-right", chat: "center", rail: "rail-top" };
}

export const useSpikeState = create<SpikeState>((set) => ({
  mode: "context",
  assignment: assignmentFor("context"),
  setMode: (mode) => set({ mode, assignment: assignmentFor(mode) }),
  toggleMode: () =>
    set((s) => {
      const next: WorkbenchMode = s.mode === "context" ? "chat" : "context";
      return { mode: next, assignment: assignmentFor(next) };
    }),
  assign: (surface, slot) => set((s) => ({ assignment: { ...s.assignment, [surface]: slot } })),
}));
