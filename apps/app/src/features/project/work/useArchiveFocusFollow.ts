/**
 * Archive moves a Work row to the other tab; focus follows to that tab, and
 * comes back to the tab the Work returns to when the command is refused.
 */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";
import { lastInputWasKeyboard, moveFocus, trackInputModality } from "@/lib/focus-follow";
import { type ArchiveTab, archiveTab } from "./work-list-model";

type Intent = { workId: string; view: ArchiveTab; ring: boolean };

const tabIn = (tabs: HTMLElement | null, view: ArchiveTab) =>
  tabs?.querySelector<HTMLElement>(`[data-tab-value="${view}"]`) ?? null;

export function useArchiveFocusFollow(works: readonly Work[] | null) {
  const tabs = useRef<HTMLDivElement>(null);
  const intent = useRef<Intent | null>(null);

  useEffect(() => trackInputModality(document), []);

  // The move is optimistic, so this fires as soon as the command starts.
  useEffect(() => {
    const target = intent.current;
    if (!target || works === null) return;
    const work = works.find((candidate) => candidate.id === target.workId);
    if (!work || archiveTab(work) !== target.view) return;
    const destination = tabIn(tabs.current, target.view);
    if (destination) moveFocus(destination, { ring: target.ring });
    intent.current = null;
  }, [works]);

  /**
   * Focus the destination tab once this Work shows there. If the command is
   * refused, the Work returns at once; focus returns with it unless the writer
   * has already moved on from the destination tab.
   */
  const follow = useCallback((workId: string, view: ArchiveTab, command: Promise<Error | null>) => {
    const next = { workId, view, ring: lastInputWasKeyboard() };
    intent.current = next;
    void command.then((error) => {
      if (!error) return;
      if (intent.current === next) intent.current = null;
      const destination = tabIn(tabs.current, view);
      const origin = tabIn(tabs.current, view === "archived" ? "active" : "archived");
      if (origin && destination && document.activeElement === destination)
        moveFocus(origin, { ring: next.ring });
    });
  }, []);

  return { tabs, follow };
}
