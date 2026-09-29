/** Archive moves a Work row to the other tab; focus follows to that tab. */
import type { Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useRef } from "react";

type Intent = { workId: string; status: Work["status"] };

export function useArchiveFocusFollow(works: readonly Work[] | null) {
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

  /** Focus the tab `status` once this Work shows there, unless its command fails first. */
  const follow = useCallback(
    (workId: string, status: Work["status"], command: Promise<Error | null>) => {
      const next = { workId, status };
      intent.current = next;
      void command.then((error) => {
        if (error && intent.current === next) intent.current = null;
      });
    },
    [],
  );

  return { tabs, follow };
}
