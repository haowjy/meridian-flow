import type { AccountSettings } from "@meridian/contracts/protocol";
import type { ProjectId } from "@meridian/contracts/runtime";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { getAccountSettings, nextAccountSettingsGeneration } from "@/client/api/account-api";
import { getAuthMe } from "@/client/api/auth-api";
import { listProjects } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { bindChatSubmissions } from "@/client/chat-submissions";
import {
  CommandDriverProvider,
  combineDomains,
  useCommands,
} from "@/client/commands/driver-context";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { FailureLogProvider } from "@/client/failures/failure-log";
import { readLastShownChat } from "@/client/project-shell/store";
import { ConnectivityProvider } from "@/client/providers/ConnectivityProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import { draftCommandsDomain } from "@/client/query/draft-commands";
import { PRESS_KIND, pressDomain } from "@/client/query/press-commands";
import { projectDomain } from "@/client/query/project-commands";
import { threadOverridesDomain } from "@/client/query/thread-overrides-command";
import { useMcpConnectionsAtOpen, useRouteProjectId } from "@/client/query/useMcpConnections";
import { workDomain } from "@/client/query/work-commands";
import { bindAccountRecents } from "@/client/recents";
import { ThreadStoreProvider } from "@/client/stores";
import { FailureToaster } from "@/components/app/failure-toast";
import { DensityPopoverCollisionProvider } from "@/components/ui/density-popover-collision";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { deleteStaleYjsCopies } from "@/core/stale-yjs-copies";
import { AccountSettingsProvider } from "@/features/account/AccountSettingsProvider";
import { SettingsDialog } from "@/features/account/SettingsDialog";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";
import { installTraceCapture } from "@/features/debug/trace/install-trace-capture";
import { ImportsProvider } from "@/features/import/ImportsProvider";
import {
  AccountFeatureComposition,
  useDraftCommandOwner,
  useLiveDocumentSessionRegistry,
} from "@/features/project/context/account-feature-context";
import { useProjectSurfacePrefsStore } from "@/features/project/layout";
import { parseProjectAddress } from "@/features/project/routing/project-address";
import { originalBrowserSearch } from "@/router-search";
import { PERSISTENT_SHELL_OPTIONS } from "@/router-shell";
import { getLandingUrl } from "@/server/landing-url";
import { loadAccountSettingsWithDeadline } from "./authenticated-account-settings";

// Composition-root prerequisite: product descendants create both client
// sockets as soon as they render, so capture must be installed first.
if (DEBUG_FEATURE_ALLOWED) {
  installTraceCapture();
}

if (typeof indexedDB !== "undefined") void deleteStaleYjsCopies(indexedDB);

// Dev-only debug surface. Inline `import.meta.env.DEV || VITE_DEBUG_OVERLAY` gate
// so the entire feature (and its lazy chunk) is dead-code-eliminated from
// production builds. Off by default in dev; toggle with ?debug=1 / ⌘⌃D, then
// Alt+click any turn/block to inspect its record. See features/debug.
const DebugOverlay =
  import.meta.env.DEV || import.meta.env.VITE_DEBUG_OVERLAY === "1"
    ? lazy(() => import("@/features/debug/DebugOverlay").then((m) => ({ default: m.DebugOverlay })))
    : null;

export const Route = createFileRoute("/_authenticated")({
  ...PERSISTENT_SHELL_OPTIONS,
  validateSearch: (search: Record<string, unknown>): { settings?: SettingsSection } => ({
    settings: isSettingsSection(search.settings) ? search.settings : undefined,
  }),
  loader: async ({ location }) => {
    const { user: workosUser } = await getAuth();
    if (!workosUser) {
      const landingUrl = location.pathname === "/" ? await getLandingUrl() : null;
      if (landingUrl) throw redirect({ href: landingUrl });
      const path = `${location.pathname}${originalBrowserSearch(location.search)}`;
      const href = await getSignInUrl({ data: { returnPathname: path } });
      throw redirect({ href });
    }

    const requestInit = ssrApiRequestInit();
    const accountSettingsReadGeneration = nextAccountSettingsGeneration();
    const settingsPromise = loadAccountSettingsWithDeadline((signal) =>
      getAccountSettings({ ...requestInit, signal }),
    );
    const authMePromise = getAuthMe(requestInit);

    const [authMe, [settingsResult, projectsResult]] = await Promise.all([
      authMePromise,
      Promise.allSettled([settingsPromise, listProjects(requestInit)]),
    ]);
    if (projectsResult.status === "rejected") {
      console.error("Failed to load project list during SSR:", projectsResult.reason);
    }
    const currentUser = {
      ...authMe.user,
      accountSettingsReadGeneration,
      accountSettings: settingsResult.status === "fulfilled" ? settingsResult.value : null,
    };
    return {
      user: currentUser,
      projects: projectsResult.status === "fulfilled" ? projectsResult.value : null,
    };
  },
  staleTime: 60_000,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { projects, user } = Route.useLoaderData();
  bindAccountRecents(user.userId);
  bindChatSubmissions(user.userId, (id) => {
    const route = parseProjectAddress(window.location.pathname, window.location.search);
    if (route.kind !== "valid") return false;
    const { projectId, destination } = route.address;
    return (
      (destination.kind === "chat" && destination.chatId === id) ||
      readLastShownChat(user.userId, projectId) === id
    );
  });

  return (
    <AppQueryProvider initialProjects={projects}>
      <ConnectivityProvider>
        <AuthenticatedAccountProviderTree user={user} />
      </ConnectivityProvider>
    </AppQueryProvider>
  );
}

function AuthenticatedAccountProviderTree({
  user,
}: {
  user: {
    userId: string;
    externalId: string;
    accountSettings: AccountSettings | null;
    accountSettingsReadGeneration: number;
  };
}) {
  return (
    <AccountFeatureComposition accountId={user.userId} externalId={user.externalId}>
      <AccountCommandDriver>
        <AccountSettingsProvider
          serverValue={user.accountSettings}
          serverReadGeneration={user.accountSettingsReadGeneration}
        >
          <AuthenticatedProviderTree user={user} />
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

function AuthenticatedProviderTree({
  user,
}: {
  user: {
    userId: string;
    accountSettings: AccountSettings | null;
    accountSettingsReadGeneration: number;
  };
}) {
  useEffect(() => {
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
  }, [user.userId]);

  return (
    <FailureLogProvider accountId={user.userId}>
      <ThreadStoreProvider>
        <TransportProvider>
          <MeridianCopilotProvider>
            <DensityPopoverCollisionProvider>
              <ImportsProvider key={user.userId}>
                <div className="app-frame">
                  <Outlet />
                </div>
                <SettingsDialog />
                <McpConnectionsAtOpen />
                <FailureToaster />
                {DebugOverlay ? (
                  <Suspense fallback={null}>
                    <DebugOverlay />
                  </Suspense>
                ) : null}
              </ImportsProvider>
            </DensityPopoverCollisionProvider>
          </MeridianCopilotProvider>
        </TransportProvider>
      </ThreadStoreProvider>
    </FailureLogProvider>
  );
}

function McpConnectionsAtOpen() {
  useMcpConnectionsAtOpen();
  return null;
}
