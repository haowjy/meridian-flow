/** Authenticated-account scope for the project feature lifetime. */
import { createContext, useContext, useInsertionEffect, useRef, useState } from "react";
import type { PostApplyDispositionOwner } from "../draft-apply-recovery/draft-apply-recovery-owner";
import { AccountFeatureLifetime } from "./account-feature-lifetime";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import type { LocalUntitledOwner } from "./local-untitled-owner";
import type { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectAvailabilityAccountContext =
  createContext<ProjectContextAvailabilityCoordinator | null>(null);
const LocalUntitledAccountContext = createContext<LocalUntitledOwner | null>(null);
const LiveDocumentRegistryAccountContext = createContext<AccountFeatureLifetime["registry"] | null>(
  null,
);
const PostApplyOwnerAccountContext = createContext<PostApplyDispositionOwner | null>(null);

export function AccountFeatureComposition({
  accountId,
  repairProjectCatalog,
  children,
}: {
  accountId: string;
  repairProjectCatalog: (projectId: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const desired = useRef({ accountId, repairProjectCatalog });
  desired.current = { accountId, repairProjectCatalog };
  const [lifetime, setLifetime] = useState(
    () => new AccountFeatureLifetime(accountId, repairProjectCatalog),
  );
  const [teardownError, setTeardownError] = useState<unknown>(null);
  const transition = useRef<Promise<void> | null>(null);

  if (teardownError) throw teardownError;
  if (lifetime.accountId !== accountId && !transition.current) {
    lifetime.beginClose();
  }

  useInsertionEffect(() => {
    if (lifetime.accountId === desired.current.accountId || transition.current) return;
    const old = lifetime;
    const closing = old
      .finishClose()
      .then(() => {
        const next = desired.current;
        setLifetime(new AccountFeatureLifetime(next.accountId, next.repairProjectCatalog));
      })
      .catch((error: unknown) => setTeardownError(error))
      .finally(() => {
        transition.current = null;
      });
    transition.current = closing;
  }, [accountId, lifetime]);

  useInsertionEffect(
    () => () => {
      lifetime.beginClose();
      void lifetime.finishClose();
    },
    [lifetime],
  );

  if (lifetime.accountId !== accountId) return null;
  return <AccountFeatureProviders lifetime={lifetime}>{children}</AccountFeatureProviders>;
}
function AccountFeatureProviders({
  lifetime,
  children,
}: {
  lifetime: AccountFeatureLifetime;
  children: React.ReactNode;
}) {
  useInsertionEffect(() => {
    lifetime.resumeFeatureLease();
    const retainedLeases = new Map<
      string,
      { lease: ReturnType<typeof lifetime.availability.attachProject>; documentIds: string[] }
    >();
    const stopRetained = lifetime.registry.observeRetainedLiveDocuments((snapshot) => {
      const byProject = new Map<string, string[]>();
      for (const reference of snapshot) {
        const ids = byProject.get(reference.projectId) ?? [];
        ids.push(reference.documentId);
        byProject.set(reference.projectId, ids);
      }
      for (const [projectId, retained] of retainedLeases) {
        if (byProject.has(projectId)) continue;
        retained.lease.release();
        retainedLeases.delete(projectId);
      }
      for (const [projectId, documentIds] of byProject) {
        let retained = retainedLeases.get(projectId);
        if (!retained) {
          retained = { lease: lifetime.availability.attachProject(projectId), documentIds: [] };
          retainedLeases.set(projectId, retained);
        }
        retained.documentIds = documentIds;
        retained.lease.watch(
          "retained-sessions",
          documentIds.map((documentId) => ({ documentId })),
        );
      }
    });
    const repair = () =>
      void Promise.all([
        lifetime.availability.recheckWatchedProjects(),
        lifetime.removal.retryPendingSessionEffects(),
      ]);
    window.addEventListener("focus", repair);
    window.addEventListener("online", repair);
    const poll = window.setInterval(repair, 60_000);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("focus", repair);
      window.removeEventListener("online", repair);
      stopRetained();
      for (const retained of retainedLeases.values()) retained.lease.release();
      lifetime.suspendFeatureLease();
    };
  }, [lifetime]);
  return (
    <ContextRemovalAccountContext.Provider value={lifetime.removal}>
      <ProjectAvailabilityAccountContext.Provider value={lifetime.availability}>
        <LocalUntitledAccountContext.Provider value={lifetime.localOwner}>
          <LiveDocumentRegistryAccountContext.Provider value={lifetime.registry}>
            <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
              <PostApplyOwnerAccountContext.Provider value={lifetime.postApplyOwner}>
                {children}
              </PostApplyOwnerAccountContext.Provider>
            </ProjectDocumentLiveOpenerContext.Provider>
          </LiveDocumentRegistryAccountContext.Provider>
        </LocalUntitledAccountContext.Provider>
      </ProjectAvailabilityAccountContext.Provider>
    </ContextRemovalAccountContext.Provider>
  );
}

export function useLocalUntitledOwner(): LocalUntitledOwner {
  const owner = useContext(LocalUntitledAccountContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

export { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export function useProjectContextAvailabilityCoordinator(): ProjectContextAvailabilityCoordinator {
  const coordinator = useContext(ProjectAvailabilityAccountContext);
  if (!coordinator) throw new Error("AccountFeatureComposition is required");
  return coordinator;
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("AccountFeatureComposition is required");
  return coordinator;
}

export function useLiveDocumentSessionRegistry(): AccountFeatureLifetime["registry"] {
  const registry = useContext(LiveDocumentRegistryAccountContext);
  if (!registry) throw new Error("AccountFeatureComposition is required");
  return registry;
}

export function useAccountPostApplyDispositionOwner(): PostApplyDispositionOwner {
  const owner = useContext(PostApplyOwnerAccountContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

export function useOptionalProjectContextAvailabilityCoordinator(): ProjectContextAvailabilityCoordinator | null {
  return useContext(ProjectAvailabilityAccountContext);
}
