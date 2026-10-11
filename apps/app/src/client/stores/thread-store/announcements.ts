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
  assertiveOwner: { key?: string } | null;
};

type AnnouncementStore = AnnouncementState & {
  setPolite: (message: string) => void;
  clearPolite: () => void;
};

const useAnnouncementStore = create<AnnouncementStore>((set) => ({
  polite: "",
  assertive: "",
  setPolite: (polite) => set({ polite }),
  assertiveOwner: null,
  clearPolite: () => set({ polite: "" }),
}));

/** Push a polite announcement. Screen readers announce it at the next pause. */
export function announce(message: string): void {
  const { clearPolite, setPolite } = useAnnouncementStore.getState();
  clearPolite();
  queueMicrotask(() => setPolite(message));
}

/** Push an assertive announcement (errors). Interrupts the current speech. */
export function announceError(message: string, options?: { key: string }): void {
  const owner = { key: options?.key };
  useAnnouncementStore.setState({ assertive: "", assertiveOwner: owner });
  queueMicrotask(() => {
    // A clear or newer alert also cancels publication that has not reached the DOM yet.
    if (useAnnouncementStore.getState().assertiveOwner === owner)
      useAnnouncementStore.setState({ assertive: message });
  });
}

/** Clear an alert only while the caller still owns it. */
export function clearAnnouncement(key: string): void {
  if (useAnnouncementStore.getState().assertiveOwner?.key === key)
    useAnnouncementStore.setState({ assertive: "", assertiveOwner: null });
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
