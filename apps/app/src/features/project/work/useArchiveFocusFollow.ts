/** Archive moves a Work row to the other tab; focus follows to that tab. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";

export function useArchiveFocusFollow(
  works: readonly Work[] | null,
  archive: (work: Work, options?: { onError?: (error: Error) => void }) => void,
) {
  const tabs = useRef<HTMLDivElement>(null);
  const intent = useRef<{ workId: string; status: Work["status"] } | null>(null);

  useEffect(() => {
    const target = intent.current;
    if (!target || works === null) return;
    if (works.find((work) => work.id === target.workId)?.status !== target.status) return;
    tabs.current?.querySelector<HTMLElement>(`[data-tab-value="${target.status}"]`)?.focus();
    intent.current = null;
  }, [works]);

  const toggleArchive = useCallback(
    (work: Work) => {
      const status = work.status === "archived" ? "active" : "archived";
      intent.current = { workId: work.id, status };
      archive(work, {
        onError: () => {
          intent.current = null;
        },
      });
    },
    [archive],
  );

  return { tabs, toggleArchive };
}
