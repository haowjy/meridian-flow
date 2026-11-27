import {
  createContext,
  useCallback,
  useContext,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RequestAccount } from "@/client/api/http-client";
import { useConnectivityHints } from "@/client/providers/ConnectivityProvider";
import type { OpenDocument } from "@/client/stores";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import { LinkSettlementsProvider } from "@/features/links/link-settlements";
import { AccountFeatureLifetime } from "./account-feature-lifetime";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";
import type { ProjectStandings } from "./project-standings";

const DraftCommandsContext = createContext<AccountFeatureLifetime["draftCommands"] | null>(null);
const PresentedContext = createContext<AccountFeatureLifetime["presented"] | null>(null);

const TreeListsAccountContext = createContext<TreeListRegistry | null>(null);
const AccountEpochContext = createContext<AbortSignal | null>(null);
const AccountContext = createContext<RequestAccount | null>(null);
const SignOutContext = createContext<(() => Promise<string>) | null>(null);

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectStandingsAccountContext = createContext<ProjectStandings | null>(null);
const LiveDocumentRegistryAccountContext = createContext<LiveDocumentSessionRegistry | null>(null);

export function AccountFeatureComposition({
  accountId,
  externalId,
  children,
}: {
  accountId: string;
  externalId: string;
  children: React.ReactNode;
}) {
  const connectivityHints = useConnectivityHints();
  const desired = useRef({ accountId, externalId });
  desired.current = { accountId, externalId };
  const [lifetime, setLifetime] = useState(
    () => new AccountFeatureLifetime(accountId, externalId, connectivityHints),
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
        setLifetime(new AccountFeatureLifetime(next.accountId, next.externalId, connectivityHints));
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
    lifetime.resumeFeatureLease();
    return () => lifetime.suspendFeatureLease();
  }, [lifetime]);
  const signOut = useCallback(() => lifetime.clearForSignOut(), [lifetime]);
  return (
    <AccountEpochContext.Provider value={lifetime.epochSignal}>
      <AccountContext.Provider value={lifetime.requests}>
        <SignOutContext.Provider value={signOut}>
          <TreeListsAccountContext.Provider value={lifetime.treeLists}>
            <ContextRemovalAccountContext.Provider value={lifetime.removal}>
              <ProjectStandingsAccountContext.Provider value={lifetime.standings}>
                <LiveDocumentRegistryAccountContext.Provider value={lifetime.registry}>
                  <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
                    <LinkSettlementsProvider value={lifetime.linkSettlements}>
                      <DraftCommandsContext.Provider value={lifetime.draftCommands}>
                        <PresentedContext.Provider value={lifetime.presented}>
                          {children}
                        </PresentedContext.Provider>
                      </DraftCommandsContext.Provider>
                    </LinkSettlementsProvider>
                  </ProjectDocumentLiveOpenerContext.Provider>
                </LiveDocumentRegistryAccountContext.Provider>
              </ProjectStandingsAccountContext.Provider>
            </ContextRemovalAccountContext.Provider>
          </TreeListsAccountContext.Provider>
        </SignOutContext.Provider>
      </AccountContext.Provider>
    </AccountEpochContext.Provider>
  );
}

export function useOptionalSignOutCleanup(): (() => Promise<string>) | null {
  return useContext(SignOutContext);
}

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

export function useLiveDocumentSessionRegistry(): LiveDocumentSessionRegistry {
  const registry = useContext(LiveDocumentRegistryAccountContext);
  if (!registry) throw new Error("AccountFeatureComposition is required");
  return registry;
}

export function useOptionalLiveDocumentSessionRegistry(): LiveDocumentSessionRegistry | null {
  return useContext(LiveDocumentRegistryAccountContext);
}

export function useAccountEpochSignal(): AbortSignal {
  const signal = useContext(AccountEpochContext);
  if (!signal) throw new Error("AccountFeatureComposition is required");
  return signal;
}

export function useAccountId(): string {
  return useRequestAccount().id;
}

export function useRequestAccount(): RequestAccount {
  const account = useContext(AccountContext);
  if (!account) throw new Error("AccountFeatureComposition is required");
  return account;
}

export function useOptionalAccountEpochSignal(): AbortSignal | null {
  return useContext(AccountEpochContext);
}

export function useDraftCommandOwner(): AccountFeatureLifetime["draftCommands"] {
  const owner = useContext(DraftCommandsContext);
  if (!owner) throw new Error("AccountFeatureComposition is required");
  return owner;
}

export function useOptionalDraftCommandOwner(): AccountFeatureLifetime["draftCommands"] | null {
  return useContext(DraftCommandsContext);
}

export function useOptionalPresentedDocuments(): AccountFeatureLifetime["presented"] | null {
  return useContext(PresentedContext);
}

const NOTHING_PRESENTED: readonly OpenDocument[] = [];

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
