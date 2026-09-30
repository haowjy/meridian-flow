/** Archive moves a Work row to the other tab; focus follows to that tab. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";
import { type ArchiveTab, archiveTab } from "./work-list-model";

type Intent = { workId: string; view: ArchiveTab };

export function useArchiveFocusFollow(works: readonly Work[] | null) {
  const tabs = useRef<HTMLDivElement>(null);
  const intent = useRef<Intent | null>(null);

  // The move is optimistic, so this fires as soon as the command starts.
  useEffect(() => {
    const target = intent.current;
    if (!target || works === null) return;
    const work = works.find((candidate) => candidate.id === target.workId);
    if (!work || archiveTab(work) !== target.view) return;
    tabs.current?.querySelector<HTMLElement>(`[data-tab-value="${target.view}"]`)?.focus();
    intent.current = null;
  }, [works]);

  /** Focus the destination tab once this Work shows there, unless its command fails first. */
  const follow = useCallback((workId: string, view: ArchiveTab, command: Promise<Error | null>) => {
    const next = { workId, view };
    intent.current = next;
    void command.then((error) => {
      if (error && intent.current === next) intent.current = null;
    });
  }, []);

  return { tabs, follow };
}
