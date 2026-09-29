/** Archive moves a Work row to the other tab; focus follows to that tab. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";
import type { WorkArchiveToggle } from "./useWorkArchiveToggle";

type Intent = { workId: string; status: Work["status"] };

export function useArchiveFocusFollow(works: readonly Work[] | null, archive: WorkArchiveToggle) {
  const tabs = useRef<HTMLDivElement>(null);
  const intent = useRef<Intent | null>(null);

  // The move is optimistic, so this fires as soon as the command starts.
  useEffect(() => {
    const target = intent.current;
    if (!target || works === null) return;
    if (works.find((work) => work.id === target.workId)?.status !== target.status) return;
    tabs.current?.querySelector<HTMLElement>(`[data-tab-value="${target.status}"]`)?.focus();
    intent.current = null;
  }, [works]);

  const follow = useCallback((next: Intent, command: Promise<boolean>) => {
    intent.current = next;
    void command.then((ok) => {
      if (!ok && intent.current === next) intent.current = null;
    });
  }, []);
  const { toggle, failureFor } = archive;

  const toggleArchive = useCallback(
    (work: Work) =>
      follow(
        { workId: work.id, status: work.status === "archived" ? "active" : "archived" },
        toggle(work),
      ),
    [toggle, follow],
  );

  const retry = useCallback(
    (workId: string) => {
      const failure = failureFor(workId);
      if (!failure) return;
      follow(
        { workId, status: failure.operation === "archive" ? "archived" : "active" },
        failure.retry(),
      );
    },
    [failureFor, follow],
  );

  return { tabs, toggleArchive, retry };
}
