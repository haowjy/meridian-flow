import { t } from "@lingui/core/macro";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
  useProjectStandings,
} from "@/client/account/account-composition";
import type { ContextRemovalRoutePort } from "@/client/project-shell/context-removal-coordinator";
import { useEndedSources } from "@/client/query/useContextSources";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
import type { AccountRecentItem } from "@/client/recents";
import { logInAgain } from "@/components/app/AppStatus";
import { dismissFailure, notifyFailure } from "@/components/app/failure-toast";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { type ListRemovalObserver, observeListRemovals } from "./list-removal-observer";
import { useOpenProjectDocument } from "./open-project-document";
import { openRecent } from "./RecentDocumentsLanding";

const SIGN_IN_EXPIRED = "sign-in-expired";

export type ProjectContextRemovalControllerProps = {
  projectId: string;
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

  const ended = useEndedSources(projectId);
  const [observer, setObserver] = useState<ListRemovalObserver | null>(null);
  useEffect(() => {
    const created = observeListRemovals({
      projectId,
      standings,
      removal: coordinator,
      registry,
      signInRequired: () =>
        notifyFailure({
          key: SIGN_IN_EXPIRED,
          title: t`Sign-in expired`,
          action: { label: t`Log in`, run: logInAgain },
        }),
      signInRestored: () => dismissFailure(SIGN_IN_EXPIRED),
    });
    setObserver(created);
    return () => {
      created.stop();
      setObserver(null);
    };
  }, [coordinator, projectId, registry, standings]);
  useEffect(() => observer?.setEndedSources(ended), [observer, ended]);

  useLayoutEffect(() => {
    const registration = coordinator.registerRoutePort(projectId, stableRoute);
    return () => registration.release();
  }, [coordinator, projectId, stableRoute]);

  return null;
}

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
