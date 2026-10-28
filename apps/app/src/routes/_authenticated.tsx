import type { AccountSettings } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, Suspense, useCallback, useEffect, useSyncExternalStore } from "react";
import { getAccountSettings, nextAccountSettingsGeneration } from "@/client/api/account-api";
import { getAuthMe } from "@/client/api/auth-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { bindChatSubmissions } from "@/client/chat-submissions";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { readCurrentChat } from "@/client/current-chat";
import { FailureLogProvider } from "@/client/failures/failure-log";
import { ConnectivityProvider } from "@/client/providers/ConnectivityProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import { bindAccountRecents } from "@/client/recents";
import {
  loadProjectList,
  ProjectStoreProvider,
  rehydrateEditorWorkspace,
  ThreadStoreProvider,
} from "@/client/stores";
import { ConnectionBanner } from "@/components/app/ConnectionBanner";
import { ToastRegion } from "@/components/app/ToastRegion";
import { ToastRegistryProvider, useToastClearance } from "@/components/app/toast-registry";
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
import { isDevAutologinEnabled } from "@/server/dev-auth";
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

// The query devtools launcher sits in the bottom-right corner, and the Activity region rises above
// it (`useToastClearance`): the bottom-left holds the rail's account footer, the top-right the
// dock's header, and a narrow window's top bar keeps its context toggle and its bottom the
// composer. Narrow by width, not pointer: a desktop browser resized to phone width gets the same
// layout as a phone, so the launcher is dropped there.
const NARROW_QUERY = "(max-width: 767px)";
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(NARROW_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(NARROW_QUERY).matches,
    () => true,
  );
}

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })),
    )
  : null;

function QueryDevtoolsLauncher({
  devtools: Devtools,
}: {
  devtools: NonNullable<typeof ReactQueryDevtools>;
}) {
  return (
    <div ref={useToastClearance()} className="fixed right-3 bottom-3 z-[55]">
      <Devtools buttonPosition="relative" initialIsOpen={false} />
    </div>
  );
}

/**
 * Decide where to send an UNAUTHENTICATED request, server-side.
 * Returns the `/dev-login` intermediary screen when dev-autologin is enabled (it
 * runs the dev-login script on a known, addressable path); otherwise WorkOS sign-in.
 */
const resolveUnauthRedirect = createServerFn({ method: "GET" })
  .inputValidator((data: { returnPathname: string }) => data)
  .handler(async ({ data }): Promise<{ to: string } | { href: string }> => {
    if (isDevAutologinEnabled()) {
      return { to: "/dev-login" };
    }

    const href = await getSignInUrl({ data: { returnPathname: data.returnPathname } });
    return { href };
  });

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
      const path = `${location.pathname}${originalBrowserSearch(location.search)}`;
      const target = await resolveUnauthRedirect({ data: { returnPathname: path } });
      throw redirect(target);
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
    return (
      (destination.kind === "chat" && destination.chatId === id) ||
      readCurrentChat(user.userId, projectId) === id
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
  const narrow = useNarrowViewport();

  // Browser persistence is initialized only after the Query composition root
  // exists. Constructing these services during SSR crashes the authenticated shell.
  useEffect(() => {
    resources?.start();
    void rehydrateEditorWorkspace(user.userId);
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
                <ToastRegistryProvider>
                  <ImportsProvider key={user.userId}>
                    <div className="app-frame flex flex-col">
                      <ConnectionBanner />
                      <div className="min-h-0 flex-1 overflow-hidden">
                        {/* Project parents key their shell by resolved identity; account fencing stays above. */}
                        <Outlet />
                      </div>
                    </div>
                    <SettingsDialog />
                    <ToastRegion />
                    {DebugOverlay ? (
                      <Suspense fallback={null}>
                        <DebugOverlay />
                      </Suspense>
                    ) : null}
                    {ReactQueryDevtools && !narrow ? (
                      <Suspense fallback={null}>
                        <QueryDevtoolsLauncher devtools={ReactQueryDevtools} />
                      </Suspense>
                    ) : null}
                  </ImportsProvider>
                </ToastRegistryProvider>
              </DensityPopoverCollisionProvider>
            </MeridianCopilotProvider>
          </TransportProvider>
        </ThreadStoreProvider>
      </ProjectStoreProvider>
    </FailureLogProvider>
  );
}
