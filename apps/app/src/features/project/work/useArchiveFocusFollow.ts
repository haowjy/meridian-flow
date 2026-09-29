/** Archive moves a Work row to the other tab; focus follows to that tab. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";
import type { WorkArchiveToggle } from "./useWorkArchiveToggle";

export function useArchiveFocusFollow(works: readonly Work[] | null, archive: WorkArchiveToggle) {
  const tabs = useRef<HTMLDivElement>(null);
  const intent = useRef<{ workId: string; status: Work["status"] } | null>(null);

  // The move is optimistic, so this fires as soon as the command starts.
  useEffect(() => {
    const target = intent.current;
    if (!target || works === null) return;
    if (works.find((work) => work.id === target.workId)?.status !== target.status) return;
    tabs.current?.querySelector<HTMLElement>(`[data-tab-value="${target.status}"]`)?.focus();
    intent.current = null;
  }, [works]);

  const onError = useCallback(() => {
    intent.current = null;
  }, []);
  const { toggle, retry: retryCommand, failure } = archive;

  const toggleArchive = useCallback(
    (work: Work) => {
      intent.current = {
        workId: work.id,
        status: work.status === "archived" ? "active" : "archived",
      };
      toggle(work, { onError });
    },
    [toggle, onError],
  );

  const retry = useCallback(() => {
    if (!failure) return;
    intent.current = {
      workId: failure.workId,
      status: failure.operation === "archive" ? "archived" : "active",
    };
    retryCommand({ onError });
  }, [failure, retryCommand, onError]);

  return { tabs, toggleArchive, retry };
}
