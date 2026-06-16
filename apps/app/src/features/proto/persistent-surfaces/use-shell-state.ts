/**
 * Shell UI state for the persistent-surfaces prototype — destination switch
 * and whether the document is peeking beside chat (reverse-portal slot).
 */
import { create } from "zustand";

import type { Destination } from "./types";

type ShellState = {
  destination: Destination;
  /** When true on Chat dest, OutPortal mounts in the side-peek slot. */
  docPeekOpen: boolean;
  setDestination: (d: Destination) => void;
  setDocPeekOpen: (open: boolean) => void;
  toggleDocPeek: () => void;
};

export const useShellState = create<ShellState>((set) => ({
  destination: "home",
  docPeekOpen: false,
  setDestination: (d) => set({ destination: d }),
  setDocPeekOpen: (open) => set({ docPeekOpen: open }),
  toggleDocPeek: () => set((s) => ({ docPeekOpen: !s.docPeekOpen })),
}));
