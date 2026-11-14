/** Live project removal host; mounted only after Work/bootstrap readiness. */

import { t } from "@lingui/core/macro";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextSourceFacts } from "@/client/query/useContextSources";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { notifyFailure } from "@/components/app/failure-toast";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import {
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
  useProjectStandings,
} from "./account-feature-context";
import type { ContextRemovalRoutePort } from "./context-removal-coordinator";
import { type ListRemovalObserver, observeListRemovals } from "./list-removal-observer";
import { useOpenProjectDocument } from "./open-project-document";
import { openRecent } from "./RecentDocumentsLanding";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
  /** The Work scope: the project's active Work. */
  editorWorkId: string;
  route: Omit<ContextRemovalRoutePort, "goBack">;
};

export function ProjectContextRemovalController({
  projectId,
  editorWorkId,
  route,
}: ProjectContextRemovalControllerProps) {
  const coordinator = useContextRemovalCoordinator();
  const standings = useProjectStandings();
  const registry = useLiveDocumentSessionRegistry();
  const recent = useRecentDocuments(projectId);
  const openDocument = useOpenProjectDocument(projectId);
  const openRoute = useOpenContextRoute();
  const latest = useRef({ route, recent: recent.documents, openDocument, openRoute, editorWorkId });
  latest.current = { route, recent: recent.documents, openDocument, openRoute, editorWorkId };
  const stableRoute = useMemo<ContextRemovalRoutePort>(
    () => ({
      transition: (projectId, target, prepared) =>
        latest.current.route.transition(projectId, target, prepared),
      goBack: (projectId, documentId, removing, isCurrent) => {
        const { recent, ...ports } = latest.current;
        const toRecents = () =>
          ports.route.transition(
            projectId,
            { kind: "clear" },
            { isCurrent, commit: () => undefined },
          );
        const before = shownBefore(recent, documentId, removing);
        return (before ? openRecent(before, { projectId, ...ports }, true) : Promise.resolve(false))
          .then(async (opened) => {
            if (opened && before) return { documentId: before.documentId };
            if (!isCurrent()) return null;
            const settlement = await toRecents();
            if (settlement.kind === "applied") return { documentId: null };
            if (settlement.kind === "failed") reportError(settlement.error);
            return null;
          })
          .catch((error: unknown) => {
            reportError(error);
            return null;
          });
      },
    }),
    [],
  );

  const queryClient = useQueryClient();
  const sources = useContextSourceFacts(projectId);
  const [observer, setObserver] = useState<ListRemovalObserver | null>(null);
  useEffect(() => {
    const created = observeListRemovals({
      projectId,
      standings,
      removal: coordinator,
      registry,
      showTrashed: (documentId) => void latest.current.openDocument({ documentId, replace: true }),
      refreshSources: () => {
        void queryClient.invalidateQueries({
          queryKey: projectQueryKeys.contextSources(projectId),
        });
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.accountContextSources() });
      },
      signInRequired: () =>
        notifyFailure({
          key: "sign-in-expired",
          title: t`Your sign-in has expired. Sign in again to keep your changes syncing; nothing you typed is lost.`,
          onRetry: () => window.location.reload(),
        }),
    });
    setObserver(created);
    return () => {
      created.stop();
      setObserver(null);
    };
  }, [coordinator, projectId, queryClient, registry, standings]);
  useEffect(() => observer?.setSources(sources), [observer, sources]);

  useLayoutEffect(() => {
    const registration = coordinator.registerRoutePort(projectId, stableRoute);
    return () => registration.release();
  }, [coordinator, projectId, stableRoute]);

  return null;
}

/**
 * Recently opened is main's opening history, newest first: the document main showed before
 * `documentId` is the next entry after it that stays. One main never recorded (a draft-only
 * page) was shown after them all, so the first entry that stays is the one before it.
 */
function shownBefore(
  recent: readonly AccountRecentItem[],
  documentId: string,
  removing: readonly string[],
): AccountRecentItem | null {
  const at = recent.findIndex((item) => item.documentId === documentId);
  return (
    recent
      .slice(at + 1)
      .find((item) => item.documentId !== documentId && !removing.includes(item.documentId)) ?? null
  );
}
