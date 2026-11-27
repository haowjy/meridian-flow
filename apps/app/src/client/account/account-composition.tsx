import type { AccountSettings } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
} from "react";
import {
  CommandDriverProvider,
  combineDomains,
  useCommands,
} from "@/client/commands/driver-context";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { FailureLogProvider } from "@/client/failures/failure-log";
import { LinkSettlementsProvider } from "@/client/link-settlements";
import { useConnectivityHints } from "@/client/providers/ConnectivityProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { chatCommandDomain } from "@/client/query/chat-commands";
import { draftCommandsDomain } from "@/client/query/draft-commands";
import { PRESS_KIND, pressDomain } from "@/client/query/press-commands";
import { projectDomain } from "@/client/query/project-commands";
import { threadOverridesDomain } from "@/client/query/thread-overrides-command";
import { useRouteProjectId } from "@/client/query/useMcpConnections";
import { workDomain } from "@/client/query/work-commands";
import { ThreadStoreProvider } from "@/client/stores";
import { DensityPopoverCollisionProvider } from "@/components/ui/density-popover-collision";
import { ProjectDocumentLiveOpenerContext } from "@/core/editor/project-document-live-opener-context";
import { AccountSettingsProvider } from "./AccountSettingsProvider";
import {
  AccountEpochContext,
  ContextRemovalContext,
  DraftCommandsContext,
  LiveDocumentRegistryContext,
  PresentedContext,
  ProjectStandingsContext,
  RequestAccountContext,
  SignOutContext,
  TreeListsContext,
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "./account-context";
import { AccountLifetime } from "./account-lifetime";

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
    <AccountLifetimeProvider accountId={user.userId} externalId={user.externalId}>
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
    </AccountLifetimeProvider>
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
          chatCommandDomain(client),
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

export function AccountLifetimeProvider({
  accountId,
  externalId,
  children,
}: {
  accountId: string;
  externalId: string;
  children: ReactNode;
}) {
  const connectivityHints = useConnectivityHints();
  const desired = useRef({ accountId, externalId });
  desired.current = { accountId, externalId };
  const [lifetime, setLifetime] = useState(
    () => new AccountLifetime(accountId, externalId, connectivityHints),
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
        setLifetime(new AccountLifetime(next.accountId, next.externalId, connectivityHints));
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
  return <LifetimeContexts lifetime={lifetime}>{children}</LifetimeContexts>;
}
function LifetimeContexts({
  lifetime,
  children,
}: {
  lifetime: AccountLifetime;
  children: ReactNode;
}) {
  useInsertionEffect(() => {
    lifetime.mount();
    return () => lifetime.unmount();
  }, [lifetime]);
  const signOut = useCallback(() => lifetime.clearForSignOut(), [lifetime]);
  return (
    <AccountEpochContext.Provider value={lifetime.epochSignal}>
      <RequestAccountContext.Provider value={lifetime.requests}>
        <SignOutContext.Provider value={signOut}>
          <TreeListsContext.Provider value={lifetime.treeLists}>
            <ContextRemovalContext.Provider value={lifetime.removal}>
              <ProjectStandingsContext.Provider value={lifetime.standings}>
                <LiveDocumentRegistryContext.Provider value={lifetime.registry}>
                  <ProjectDocumentLiveOpenerContext.Provider value={lifetime.opener}>
                    <LinkSettlementsProvider value={lifetime.linkSettlements}>
                      <DraftCommandsContext.Provider value={lifetime.draftCommands}>
                        <PresentedContext.Provider value={lifetime.presented}>
                          {children}
                        </PresentedContext.Provider>
                      </DraftCommandsContext.Provider>
                    </LinkSettlementsProvider>
                  </ProjectDocumentLiveOpenerContext.Provider>
                </LiveDocumentRegistryContext.Provider>
              </ProjectStandingsContext.Provider>
            </ContextRemovalContext.Provider>
          </TreeListsContext.Provider>
        </SignOutContext.Provider>
      </RequestAccountContext.Provider>
    </AccountEpochContext.Provider>
  );
}
