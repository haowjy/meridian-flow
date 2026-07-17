import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { lazy, Suspense, useEffect } from "react";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import {
  loadProjectList,
  ProjectStoreProvider,
  ThreadStoreProvider,
  useIndependentProjectsStore,
} from "@/client/stores";
import { ConnectionBanner } from "@/components/app/ConnectionBanner";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import {
  isSettingsSection,
  SettingsDialog,
  type SettingsSection,
} from "@/features/account/SettingsDialog";
import { installYjsTap } from "@/features/debug/trace/install-yjs-tap";
import { useProjectSurfacePrefsStore } from "@/features/project/layout";
import { isDevAutologinEnabled } from "@/server/dev-auth";

// Composition-root prerequisite: product descendants can create the shared
// Yjs socket as soon as they render, so capture must be installed first.
if (DEBUG_FEATURE_ALLOWED) installYjsTap();

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

    const currentUser = { userId: user.id, email: user.email ?? null };
    const now = Date.now();

    // `/` immediately redirects to the default project, so skip its list fetch;
    // every other authenticated route mounts the same shell and wants the list.
    if (location.pathname === "/") {
      return { user: currentUser, projects: null, now };
    }

    try {
      return { user: currentUser, projects: await loadProjectList(), now };
    } catch (error) {
      console.error("Failed to load project list during SSR:", error);
      return { user: currentUser, projects: null, now };
    }
  },
  staleTime: 60_000,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { projects, now } = Route.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Rehydrate localStorage-backed UI stores on the client only (all use
  // skipHydration to avoid SSR mismatch). Idempotent; fires once after mount.
  useEffect(() => {
    void useIndependentProjectsStore.persist.rehydrate();
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
  }, []);

  // One unconditional provider tree for every authenticated route — the settings
  // overlay (`?settings=`) and the standalone /billing page render over the same
  // stores. No pathname-based provider gating: a conditional tree dropped
  // ThreadStoreProvider during light↔workspace transitions.
  return (
    <AppQueryProvider initialProjects={projects}>
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
              <SettingsDialog />
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
    </AppQueryProvider>
  );
}
