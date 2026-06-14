// @ts-nocheck
/**
 * Client-only module singleton for screen-reader live regions. Announcements are
 * not SSR-rendered (see {@link AnnouncementRegion} in `__root.tsx`), so this
 * does not need per-request isolation like {@link thread-store}.
 */
import { useCallback } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

type AnnouncementState = {
  polite: string;
  assertive: string;
};

type AnnouncementStore = AnnouncementState & {
  setPolite: (message: string) => void;
  setAssertive: (message: string) => void;
  clearPolite: () => void;
  clearAssertive: () => void;
};

const useAnnouncementStore = create<AnnouncementStore>((set) => ({
  polite: "",
  assertive: "",
  setPolite: (polite) => set({ polite }),
  setAssertive: (assertive) => set({ assertive }),
  clearPolite: () => set({ polite: "" }),
  clearAssertive: () => set({ assertive: "" }),
}));

/** Push a polite announcement. Screen readers announce it at the next pause. */
export function announce(message: string): void {
  const { clearPolite, setPolite } = useAnnouncementStore.getState();
  clearPolite();
  queueMicrotask(() => setPolite(message));
}

/** Push an assertive announcement (errors). Interrupts the current speech. */
export function announceError(message: string): void {
  const { clearAssertive, setAssertive } = useAnnouncementStore.getState();
  clearAssertive();
  queueMicrotask(() => setAssertive(message));
}

/** React hook for {@link AnnouncementRegion} and components that announce. */
export function useAnnouncement() {
  const current = useAnnouncementStore(
    useShallow((s) => ({ polite: s.polite, assertive: s.assertive })),
  );

  return {
    current,
    announce: useCallback((msg: string) => announce(msg), []),
    announceError: useCallback((msg: string) => announceError(msg), []),
  };
}
