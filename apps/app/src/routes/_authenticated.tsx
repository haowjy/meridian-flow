import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { getAccountSettings } from "@/client/api/account-api";
import { ssrApiRequestInit } from "@/client/api/ssr-api-request";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import {
  loadProjectList,
  ProjectStoreProvider,
  rehydrateContextDesks,
  ThreadStoreProvider,
  useIndependentProjectsStore,
} from "@/client/stores";
import { configureWorkingSetSync } from "@/client/working-set";
import { ConnectionBanner } from "@/components/app/ConnectionBanner";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import {
  isSettingsSection,
  SettingsDialog,
  type SettingsSection,
} from "@/features/account/SettingsDialog";
import { installTraceCapture } from "@/features/debug/trace/install-trace-capture";
import { createContextIdentityMutationService } from "@/features/project/context/context-identity-mutation";
import {
  getUntitledReconciler,
  isUntitledPending,
} from "@/features/project/context/untitled-reconciler-browser";
import { useProjectSurfacePrefsStore } from "@/features/project/layout";
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

const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((m) => ({ default: m.ReactQueryDevtools })),
    )
  : null;

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
  // `?settings=` is layout-owned so the settings overlay is URL-addressable from
  // ANY authenticated route — the path stays put, only the param toggles.
  // See `features/account/SettingsDialog`.
  validateSearch: (search: Record<string, unknown>): { settings?: SettingsSection } => ({
    settings: isSettingsSection(search.settings) ? search.settings : undefined,
  }),
  loader: async ({ location }) => {
    const { user } = await getAuth();
    if (!user) {
      const path = `${location.pathname}${location.searchStr}`;
      const target = await resolveUnauthRedirect({ data: { returnPathname: path } });
      throw redirect(target);
    }

    const now = Date.now();
    const requestInit = ssrApiRequestInit();
    const settingsPromise = loadAccountSettingsWithDeadline((signal) =>
      getAccountSettings({ ...requestInit, signal }),
    );

    // `/` immediately redirects to the default project, so skip its list fetch;
    // every other authenticated route mounts the same shell and wants the list.
    if (location.pathname === "/") {
      const settings = await settingsPromise;
      const currentUser = {
        userId: user.id,
        email: user.email ?? null,
        workingSetSyncEnabled: settings?.workingSetSyncEnabled ?? null,
      };
      return { user: currentUser, projects: null, now };
    }

    const [settingsResult, projectsResult] = await Promise.allSettled([
      settingsPromise,
      loadProjectList(),
    ]);
    if (projectsResult.status === "rejected") {
      console.error("Failed to load project list during SSR:", projectsResult.reason);
    }
    const currentUser = {
      userId: user.id,
      email: user.email ?? null,
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
  configureWorkingSetSync(user.userId, user.workingSetSyncEnabled === true);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // One unconditional provider tree for every authenticated route — the settings
  // overlay (`?settings=`) and the standalone /billing page render over the same
  // stores. No pathname-based provider gating: a conditional tree dropped
  // ThreadStoreProvider during light↔workspace transitions.
  return (
    <AppQueryProvider initialProjects={projects}>
      <AuthenticatedProviderTree now={now} pathname={pathname} user={user} />
    </AppQueryProvider>
  );
}

function AuthenticatedProviderTree({
  now,
  pathname,
  user,
}: {
  now: number;
  pathname: string;
  user: { userId: string; workingSetSyncEnabled: boolean | null };
}) {
  const queryClient = useQueryClient();
  const untitledReconciler = useMemo(
    () =>
      typeof window === "undefined"
        ? null
        : getUntitledReconciler(createContextIdentityMutationService(queryClient)),
    [queryClient],
  );

  // Browser persistence is initialized only after the Query composition root
  // exists. Constructing these services during SSR crashes the authenticated shell.
  useEffect(() => {
    if (!untitledReconciler) return;
    untitledReconciler.rehydrate();
    untitledReconciler.start();
    rehydrateContextDesks(user.userId, isUntitledPending);
    void useIndependentProjectsStore.persist.rehydrate();
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
    return () => untitledReconciler.dispose();
  }, [untitledReconciler, user.userId]);

  return (
    <ProjectStoreProvider now={now}>
      <ThreadStoreProvider now={now}>
        <TransportProvider>
          <MeridianCopilotProvider>
            <div className="app-frame flex flex-col">
              <ConnectionBanner />
              <div className="min-h-0 flex-1 overflow-hidden">
                {/* Keyed by pathname to force a full remount per route — the
                      providers above stay mounted, so this intentionally discards
                      in-route state on navigation (e.g. /project/$id ↔ /billing)
                      rather than reconciling stale subtrees across routes. */}
                <Outlet key={pathname} />
              </div>
            </div>
            <SettingsDialog workingSetSyncEnabled={user.workingSetSyncEnabled} />
            {DebugOverlay ? (
              <Suspense fallback={null}>
                <DebugOverlay />
              </Suspense>
            ) : null}
            {ReactQueryDevtools ? (
              <Suspense fallback={null}>
                <ReactQueryDevtools buttonPosition="bottom-left" initialIsOpen={false} />
              </Suspense>
            ) : null}
          </MeridianCopilotProvider>
        </TransportProvider>
      </ThreadStoreProvider>
    </ProjectStoreProvider>
  );
}
