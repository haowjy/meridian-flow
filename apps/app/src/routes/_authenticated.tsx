import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { AccountComposition } from "@/client/account/account-composition";
import { getAccountSettings, nextAccountSettingsGeneration } from "@/client/api/account-api";
import { getAuthMe } from "@/client/api/auth-api";
import { listProjects } from "@/client/api/projects-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { bindChatSubmissions } from "@/client/chat-submissions";
import { readLastShownChat } from "@/client/project-shell/store";
import { ConnectivityProvider } from "@/client/providers/ConnectivityProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import { useMcpConnectionsAtOpen } from "@/client/query/useMcpConnections";
import { bindAccountRecents } from "@/client/recents";
import { FailureToaster } from "@/components/app/failure-toast";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { deleteStaleYjsCopies } from "@/core/stale-yjs-copies";
import { SettingsDialog } from "@/features/account/SettingsDialog";
import { isSettingsSection, type SettingsSection } from "@/features/account/settings-sections";
import { installTraceCapture } from "@/features/debug/trace/install-trace-capture";
import { ImportsProvider } from "@/features/import/ImportsProvider";
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
        <AccountComposition user={user}>
          <AccountSurfacePrefs userId={user.userId}>
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
          </AccountSurfacePrefs>
        </AccountComposition>
      </ConnectivityProvider>
    </AppQueryProvider>
  );
}

function AccountSurfacePrefs({ userId, children }: { userId: string; children: ReactNode }) {
  useEffect(() => {
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
  }, [userId]);
  return children;
}

function McpConnectionsAtOpen() {
  useMcpConnectionsAtOpen();
  return null;
}
