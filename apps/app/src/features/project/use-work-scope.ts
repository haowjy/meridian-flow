import { useCallback, useMemo } from "react";
import { useCurrentWork, writeCurrentWork } from "@/client/current-work";
import { useWorks } from "@/client/query/useWorks";
import { useAccountId } from "./context/account-feature-context";
import { modeOf } from "./layout/placement";
import { useProjectScreen, useScreenCommands } from "./routing/ProjectNavigationContext";

/**
 * The Work scope the v1 shell's picker reads and sets, per browser tab.
 *
 * `workId` is a Work row id, No Work's included, and `null` only while the Work catalog has not
 * loaded. A remembered Work the catalog no longer holds resolves to No Work.
 *
 * Adapter over today's Work selection, which PR 3 replaces:
 * - The store is the remembered-Work record, kept current by the Editor and Work page routes
 *   (they write it when their Work changes), so `workId` follows `?work` and the Work page.
 * - In Write mode `setWorkId` goes through the address (`?work=<id>`), with or without a document;
 *   the store follows when the route settles, so the URL is the only owner of Write's scope. In
 *   Chat mode it only writes the store; no chat is rebound.
 */
export function useWorkScope(projectId: string): {
  workId: string | null;
  setWorkId(id: string): void;
} {
  const accountId = useAccountId();
  const remembered = useCurrentWork(accountId, projectId);
  const works = useWorks(projectId);
  const mode = modeOf(useProjectScreen());
  const setEditorWork = useScreenCommands()?.setEditorWork;

  const noWorkId = works.noWork?.id ?? null;
  const catalogReady = works.status === "ready" || works.status === "empty";
  const known =
    remembered !== null &&
    (remembered === noWorkId ||
      works.works?.some((work) => work.id === remembered) ||
      works.creations.has(remembered));
  const workId = !catalogReady || !noWorkId ? null : known ? remembered : noWorkId;

  const setWorkId = useCallback(
    (id: string) => {
      if (mode === "write" && setEditorWork) void setEditorWork(id);
      else writeCurrentWork(accountId, projectId, id);
    },
    [accountId, projectId, mode, setEditorWork],
  );

  return useMemo(() => ({ workId, setWorkId }), [workId, setWorkId]);
}
