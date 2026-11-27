import type { AccountSettings } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  CommandDriverProvider,
  combineDomains,
  useCommands,
} from "@/client/commands/driver-context";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { FailureLogProvider } from "@/client/failures/failure-log";
import { LinkSettlementsProvider } from "@/client/link-settlements";
import type { ContextRemovalCoordinator } from "@/client/project-shell/context-removal-coordinator";
import { useConnectivityHints } from "@/client/providers/ConnectivityProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { draftCommandsDomain } from "@/client/query/draft-commands";
import { PRESS_KIND, pressDomain } from "@/client/query/press-commands";
import { projectDomain } from "@/client/query/project-commands";
import { threadOverridesDomain } from "@/client/query/thread-overrides-command";
import { useRouteProjectId } from "@/client/query/useMcpConnections";
import { workDomain } from "@/client/query/work-commands";
import { type OpenDocument, ThreadStoreProvider } from "@/client/stores";
import { DensityPopoverCollisionProvider } from "@/components/ui/density-popover-collision";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { ProjectDocumentLiveOpenerContext } from "@/core/editor/project-document-live-opener-context";
import type { ProjectStandings } from "@/core/tree-list/project-standings";
import type { TreeListRegistry } from "@/core/tree-list/tree-list-registry";
import { AccountSettingsProvider } from "./AccountSettingsProvider";
import { AccountEpochContext, RequestAccountContext, SignOutContext } from "./account-context";
import { AccountFeatureLifetime } from "./account-lifetime";

const DraftCommandsContext = createContext<AccountFeatureLifetime["draftCommands"] | null>(null);
const PresentedContext = createContext<AccountFeatureLifetime["presented"] | null>(null);

const TreeListsAccountContext = createContext<TreeListRegistry | null>(null);

const ContextRemovalAccountContext = createContext<ContextRemovalCoordinator | null>(null);
const ProjectStandingsAccountContext = createContext<ProjectStandings | null>(null);
const LiveDocumentRegistryAccountContext = createContext<LiveDocumentSessionRegistry | null>(null);

export function AccountComposition({
  user,
  children,
}: {
  user: {
    userId: string;
    externalId: string;
    accountSettings: AccountSettings | null;
    accountSettingsReadGeneration: number;
  };
  children: ReactNode;
}) {
  return (
    <AccountFeatureComposition accountId={user.userId} externalId={user.externalId}>
      <AccountCommandDriver>
        <AccountSettingsProvider
          serverValue={user.accountSettings}
          serverReadGeneration={user.accountSettingsReadGeneration}
        >
          <FailureLogProvider>
            <ThreadStoreProvider>
              <TransportProvider>
                <MeridianCopilotProvider>
                  <DensityPopoverCollisionProvider>{children}</DensityPopoverCollisionProvider>
                </MeridianCopilotProvider>
              </TransportProvider>
            </ThreadStoreProvider>
          </FailureLogProvider>
        </AccountSettingsProvider>
      </AccountCommandDriver>
    </AccountFeatureComposition>
  );
}

function AccountCommandDriver({ children }: { children: ReactNode }) {
  const registry = useLiveDocumentSessionRegistry();
  return (
    <CommandDriverProvider
      domains={(client) =>
        combineDomains(
          workDomain(client),
          projectDomain(client),
          threadOverridesDomain(client),
          draftCommandsDomain(client),
          pressDomain(client, (projectId, rooms) =>
            registry.whenSentAcknowledged(projectId as ProjectId, rooms),
          ),
        )
      }
    >
      <FollowPresses />
      {children}
    </CommandDriverProvider>
  );
}

function FollowPresses() {
  const owner = useDraftCommandOwner();
  const presses = useCommands({ kind: PRESS_KIND });
  const shownProject = useRouteProjectId();
  useEffect(() => owner.followPresses(presses, shownProject), [owner, presses, shownProject]);
  return null;
}

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
      <RequestAccountContext.Provider value={lifetime.requests}>
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
      </RequestAccountContext.Provider>
    </AccountEpochContext.Provider>
  );
}

export function useOptionalTreeLists(): TreeListRegistry | null {
  return useContext(TreeListsAccountContext);
}

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
