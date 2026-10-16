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
  assertiveOwner: { token: object; entries: { key?: string; message: string }[] } | null;
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

/** Publish a batch in one live-region update; report only keys actually published. */
export function announceErrors(
  entries: { key: string; message: string }[],
  published: (keys: string[]) => void,
): void {
  publishErrors(entries, (keys) =>
    published(keys.filter((key): key is string => key !== undefined)),
  );
}

function publishErrors(
  entries: { key?: string; message: string }[],
  published?: (keys: (string | undefined)[]) => void,
): void {
  const owner = { token: {}, entries };
  useAnnouncementStore.setState({ assertive: "", assertiveOwner: owner });
  queueMicrotask(() => {
    const current = useAnnouncementStore.getState().assertiveOwner;
    if (current?.token !== owner.token) return;
    useAnnouncementStore.setState({
      assertive: current.entries.map((entry) => entry.message).join(" "),
    });
    published?.(current.entries.map((entry) => entry.key));
  });
}

/** Push an assertive announcement (errors). Interrupts the current speech. */
export function announceError(message: string, options?: { key: string }): void {
  publishErrors([{ key: options?.key, message }]);
}

/** Retire a key, filtering unpublished batches and clearing published text without re-speaking survivors. */
export function clearAnnouncement(key: string): void {
  const { assertiveOwner: owner } = useAnnouncementStore.getState();
  if (!owner?.entries.some((entry) => entry.key === key)) return;
  const entries = owner.entries.filter((entry) => entry.key !== key);
  useAnnouncementStore.setState({
    assertiveOwner: entries.length ? { ...owner, entries } : null,
    // An atomic region must not rewrite the surviving sentences and announce them again.
    assertive: "",
  });
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
