/** Authenticated-account scope for the project feature lifetime. */
import type { QueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { scopeCreationRegistry } from "@/client/creation/creation-registry";
import { useConnectivityHints } from "@/client/providers/ConnectivityProvider";
import type { OpenDocument } from "@/client/stores";
import type { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import { LinkSettlementsProvider } from "@/features/links/link-settlements";
import { AccountFeatureLifetime } from "./account-feature-lifetime";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";
import type { ProjectStandings } from "./project-standings";
import type { RemovedNoticeStore } from "./removed-notice-store";

const DraftCommandsContext = createContext<AccountFeatureLifetime["draftCommands"] | null>(null);
const DraftOnlyContext = createContext<AccountFeatureLifetime["draftOnly"] | null>(null);
const PresentedContext = createContext<AccountFeatureLifetime["presented"] | null>(null);

const TreeListsAccountContext = createContext<TreeListRegistry | null>(null);
const AccountEpochContext = createContext<AbortSignal | null>(null);
const AccountIdContext = createContext<string | null>(null);
const SignOutContext = createContext<(() => Promise<void>) | null>(null);

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectStandingsAccountContext = createContext<ProjectStandings | null>(null);
const RemovedNoticesAccountContext = createContext<RemovedNoticeStore | null>(null);
const LiveDocumentRegistryAccountContext = createContext<AccountFeatureLifetime["registry"] | null>(
  null,
);

export function AccountFeatureComposition({
  accountId,
  queryClient,
  children,
}: {
  accountId: string;
  queryClient: QueryClient;
  children: React.ReactNode;
}) {
  const connectivityHints = useConnectivityHints();
  const desired = useRef({ accountId, queryClient });
  desired.current = { accountId, queryClient };
  const invalidationHandler = useRef<(error: Error) => void>(() => undefined);
  const [lifetime, setLifetime] = useState(
    () =>
      new AccountFeatureLifetime(
        accountId,
        queryClient,
        (error) => invalidationHandler.current(error),
        connectivityHints,
      ),
  );
  const [teardownError, setTeardownError] = useState<unknown>(null);
  invalidationHandler.current = setTeardownError;
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
        setLifetime(
          new AccountFeatureLifetime(
            next.accountId,
            next.queryClient,
            (error) => invalidationHandler.current(error),
            connectivityHints,
          ),
        );
      })
      .catch((error: unknown) => setTeardownError(error))
      .finally(() => {
        transition.current = null;
      });
    transition.current = closing;
  }, [accountId, lifetime, connectivityHints]);

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
    scopeCreationRegistry(lifetime.accountId);
  }, [lifetime.accountId]);

  useInsertionEffect(() => {
    lifetime.resumeFeatureLease();
    return () => lifetime.suspendFeatureLease();
  }, [lifetime]);
  const signOut = useCallback(() => lifetime.clearForSignOut(), [lifetime]);
  return (
    <AccountEpochContext.Provider value={lifetime.runtime.epochSignal}>
      <AccountIdContext.Provider value={lifetime.accountId}>
        <SignOutContext.Provider value={signOut}>
          <TreeListsAccountContext.Provider value={lifetime.treeLists}>
            <ContextRemovalAccountContext.Provider value={lifetime.removal}>
              <ProjectStandingsAccountContext.Provider value={lifetime.standings}>
                <LiveDocumentRegistryAccountContext.Provider value={lifetime.registry}>
                  <RemovedNoticesAccountContext.Provider value={lifetime.notices}>
                    <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
                      <LinkSettlementsProvider value={lifetime.linkSettlements}>
                        <DraftCommandsContext.Provider value={lifetime.draftCommands}>
                          <DraftOnlyContext.Provider value={lifetime.draftOnly}>
                            <PresentedContext.Provider value={lifetime.presented}>
                              {children}
                            </PresentedContext.Provider>
                          </DraftOnlyContext.Provider>
                        </DraftCommandsContext.Provider>
                      </LinkSettlementsProvider>
                    </ProjectDocumentLiveOpenerContext.Provider>
                  </RemovedNoticesAccountContext.Provider>
                </LiveDocumentRegistryAccountContext.Provider>
              </ProjectStandingsAccountContext.Provider>
            </ContextRemovalAccountContext.Provider>
          </TreeListsAccountContext.Provider>
        </SignOutContext.Provider>
      </AccountIdContext.Provider>
    </AccountEpochContext.Provider>
  );
}

/** Closes the account's sessions and deletes its local copies before sign-out; null outside the authenticated shell. */
export function useOptionalSignOutCleanup(): (() => Promise<void>) | null {
  return useContext(SignOutContext);
}

/** The account's open tree lists; null outside the authenticated shell. */
export function useOptionalTreeLists(): TreeListRegistry | null {
  return useContext(TreeListsAccountContext);
}

export { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export function useProjectStandings(): ProjectStandings {
  const standings = useContext(ProjectStandingsAccountContext);
  if (!standings) throw new Error("AccountFeatureComposition is required");
  return standings;
}

export function useContextRemovalCoordinator(): ContextRemovalCoordinator {
  const coordinator = useContext(ContextRemovalAccountContext);
  if (!coordinator) throw new Error("AccountFeatureComposition is required");
  return coordinator;
}

export function useOptionalContextRemovalCoordinator(): ContextRemovalCoordinator | null {
  return useContext(ContextRemovalAccountContext);
}

export function useLiveDocumentSessionRegistry(): AccountFeatureLifetime["registry"] {
  const registry = useContext(LiveDocumentRegistryAccountContext);
  if (!registry) throw new Error("AccountFeatureComposition is required");
  return registry;
}

export function useOptionalProjectStandings(): ProjectStandings | null {
  return useContext(ProjectStandingsAccountContext);
}

/** Immediate account-close fence, including the render-before-unmount transition. */
export function useAccountEpochSignal(): AbortSignal {
  const signal = useContext(AccountEpochContext);
  if (!signal) throw new Error("AccountFeatureComposition is required");
  return signal;
}

/** The removed-documents notice store; null outside the authenticated shell. */
export function useOptionalRemovedNotices(): RemovedNoticeStore | null {
  return useContext(RemovedNoticesAccountContext);
}

export function useAccountId(): string {
  const accountId = useContext(AccountIdContext);
  if (!accountId) throw new Error("AccountFeatureComposition is required");
  return accountId;
}

export function useOptionalAccountId(): string | null {
  return useContext(AccountIdContext);
}

/**
 * Account epoch for command owners that also render outside the authenticated
 * shell (tests, SSR). `null` means there is no account lifetime to fence yet.
 */
export function useOptionalAccountEpochSignal(): AbortSignal | null {
  return useContext(AccountEpochContext);
}

export function useDraftCommandOwner(): AccountFeatureLifetime["draftCommands"] {
  const owner = useContext(DraftCommandsContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

/** The draft-only documents mounted hosts present; null outside the authenticated shell. */
export function useOptionalDraftOnlyPresentations(): AccountFeatureLifetime["draftOnly"] | null {
  return useContext(DraftOnlyContext);
}

/** The documents this browser tab's hosts mount and present; null outside the authenticated shell. */
export function useOptionalPresentedDocuments(): AccountFeatureLifetime["presented"] | null {
  return useContext(PresentedContext);
}

const NOTHING_PRESENTED: readonly OpenDocument[] = [];

/** The documents this browser tab's hosts present in a project, main's first. */
export function usePresentedDocuments(projectId: string): readonly OpenDocument[] {
  const presented = useContext(PresentedContext);
  return useSyncExternalStore(
    presented?.subscribe ?? noSubscription,
    () => presented?.documents(projectId) ?? NOTHING_PRESENTED,
    () => NOTHING_PRESENTED,
  );
}

/** The documents mounted in a project, newest on screen first (`PresentedDocuments.shown`). */
export function useShownDocuments(projectId: string): readonly OpenDocument[] {
  const presented = useContext(PresentedContext);
  return useSyncExternalStore(
    presented?.subscribe ?? noSubscription,
    () => presented?.shown(projectId) ?? NOTHING_PRESENTED,
    () => NOTHING_PRESENTED,
  );
}

function noSubscription(): () => void {
  return () => undefined;
}
