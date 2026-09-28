/** Keep focus on a Work row as Archive moves it between collection sections. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";

export function useArchiveFocusFollow(
  works: readonly Work[] | null,
  archivedOpen: boolean,
  archive: (work: Work, options?: { onError?: (error: Error) => void }) => void,
) {
  const archivedDisclosure = useRef<HTMLButtonElement>(null);
  const openRefs = useRef(new Map<string, HTMLAnchorElement>());
  const lifecycleFocus = useRef<{ workId: string; status: Work["status"] } | null>(null);

  useEffect(() => {
    const intent = lifecycleFocus.current;
    if (!intent || works === null) return;
    const committed = works.find((work) => work.id === intent.workId);
    if (committed?.status !== intent.status) return;
    const target =
      intent.status === "archived" && !archivedOpen
        ? archivedDisclosure.current
        : openRefs.current.get(intent.workId);
    if (!target) return;
    target.focus();
    lifecycleFocus.current = null;
  }, [archivedOpen, works]);

  const registerOpenFocus = useCallback(
    (id: string) => (node: HTMLAnchorElement | null) => {
      if (node) openRefs.current.set(id, node);
      else openRefs.current.delete(id);
    },
    [],
  );
  const toggleArchive = useCallback(
    (work: Work) => {
      const status = work.status === "archived" ? "active" : "archived";
      lifecycleFocus.current = { workId: work.id, status };
      archive(work, {
        onError: () => {
          lifecycleFocus.current = null;
        },
      });
    },
    [archive],
  );

  return {
    archivedDisclosure,
    registerOpenFocus,
    toggleArchive,
  };
}
