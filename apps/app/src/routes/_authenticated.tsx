import type { AccountSettings } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, Suspense, useCallback, useEffect } from "react";
import { getAccountSettings, nextAccountSettingsGeneration } from "@/client/api/account-api";
import { getAuthMe } from "@/client/api/auth-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { bindChatSubmissions } from "@/client/chat-submissions";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { FailureLogProvider } from "@/client/failures/failure-log";
import { readHeldPick, readLastChat } from "@/client/project-shell/store";
import { ConnectivityProvider } from "@/client/providers/ConnectivityProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import { bindAccountRecents } from "@/client/recents";
import { loadProjectList, ProjectStoreProvider, ThreadStoreProvider } from "@/client/stores";
import { FailureToaster } from "@/components/app/failure-toast";
import { DensityPopoverCollisionProvider } from "@/components/ui/density-popover-collision";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { AccountSettingsProvider } from "@/features/account/AccountSettingsProvider";
import { SettingsDialog } from "@/features/account/SettingsDialog";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";
import { installTraceCapture } from "@/features/debug/trace/install-trace-capture";
import { ImportsProvider } from "@/features/import/ImportsProvider";
import {
  AccountFeatureComposition,
  useOptionalAccountResourceReplica,
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
  // `?settings=` is layout-owned so the settings overlay is URL-addressable from
  // ANY authenticated route — the path stays put, only the param toggles.
  // See `features/account/SettingsDialog`.
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

    const now = Date.now();
    const requestInit = ssrApiRequestInit();
    const accountSettingsReadGeneration = nextAccountSettingsGeneration();
    const settingsPromise = loadAccountSettingsWithDeadline((signal) =>
      getAccountSettings({ ...requestInit, signal }),
    );
    const authMePromise = getAuthMe(requestInit);

    const [authMe, [settingsResult, projectsResult]] = await Promise.all([
      authMePromise,
      Promise.allSettled([settingsPromise, loadProjectList()]),
    ]);
    if (projectsResult.status === "rejected") {
      console.error("Failed to load project list during SSR:", projectsResult.reason);
    }
    const currentUser = {
      ...authMe.user,
      accountSettingsReadGeneration,
      accountSettings: settingsResult.status === "fulfilled" ? settingsResult.value : null,
      workingSetSyncEnabled:
        settingsResult.status === "fulfilled"
          ? (settingsResult.value?.workingSetSyncEnabled ?? null)
          : null,
    };
    return {
      user: currentUser,
      projects: projectsResult.status === "fulfilled" ? projectsResult.value : null,
      now,
    };
  },
  staleTime: 60_000,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { projects, now, user } = Route.useLoaderData();
  bindAccountRecents(user.userId);
  bindChatSubmissions(user.userId, (id) => {
    const route = parseProjectAddress(window.location.pathname, window.location.search);
    if (route.kind !== "valid") return false;
    const { projectId, destination } = route.address;
    const held = readHeldPick(user.userId, projectId);
    return (
      (destination.kind === "chat" && destination.chatId === id) ||
      readLastChat(user.userId, projectId) === id ||
      (held?.kind === "chat" && held.chatId === id)
    );
  });

  // One unconditional provider tree for every authenticated route — the settings
  // overlay (`?settings=`) and the standalone /billing page render over the same
  // stores. No pathname-based provider gating: a conditional tree dropped
  // ThreadStoreProvider during light↔workspace transitions.
  return (
    <AppQueryProvider initialProjects={projects}>
      <ConnectivityProvider>
        <AuthenticatedAccountProviderTree now={now} user={user} />
      </ConnectivityProvider>
    </AppQueryProvider>
  );
}

function AuthenticatedAccountProviderTree({
  now,
  user,
}: {
  now: number;
  user: {
    userId: string;
    workingSetSyncEnabled: boolean | null;
    accountSettings: AccountSettings | null;
    accountSettingsReadGeneration: number;
  };
}) {
  const queryClient = useQueryClient();
  const repairProjectCatalog = useCallback(
    (projectId: string) =>
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "context-catalog"],
      }),
    [queryClient],
  );
  return (
    <AccountFeatureComposition accountId={user.userId} repairProjectCatalog={repairProjectCatalog}>
      <AccountSettingsProvider
        serverValue={user.accountSettings}
        serverReadGeneration={user.accountSettingsReadGeneration}
      >
        <AuthenticatedProviderTree now={now} user={user} />
      </AccountSettingsProvider>
    </AccountFeatureComposition>
  );
}

function AuthenticatedProviderTree({
  now,
  user,
}: {
  now: number;
  user: {
    userId: string;
    workingSetSyncEnabled: boolean | null;
    accountSettings: AccountSettings | null;
    accountSettingsReadGeneration: number;
  };
}) {
  const resources = useOptionalAccountResourceReplica();

  // Browser persistence is initialized only after the Query composition root
  // exists. Constructing these services during SSR crashes the authenticated shell.
  useEffect(() => {
    resources?.start();
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
  }, [resources, user.userId]);

  return (
    <FailureLogProvider accountId={user.userId}>
      <ProjectStoreProvider now={now}>
        <ThreadStoreProvider now={now}>
          <TransportProvider>
            <MeridianCopilotProvider>
              <DensityPopoverCollisionProvider>
                <ImportsProvider key={user.userId}>
                  <div className="app-frame">
                    {/* Project parents key their shell by resolved identity; account fencing stays above. */}
                    <Outlet />
                  </div>
                  <SettingsDialog />
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
      </ProjectStoreProvider>
    </FailureLogProvider>
  );
}
