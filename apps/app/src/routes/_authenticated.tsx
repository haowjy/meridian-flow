import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getAuth, getSignInUrl } from "@workos/authkit-tanstack-react-start";
import { useEffect } from "react";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import {
  loadProjectList,
  ProjectStoreProvider,
  ThreadStoreProvider,
  useIndependentProjectsStore,
  useLayoutStore,
} from "@/client/stores";
import { ConnectionBanner } from "@/components/app/ConnectionBanner";
import { SettingsDialog } from "@/features/account/SettingsDialog";
import {
  seedContextFilesPanelFromLegacy,
  useContextFilesPanelStore,
} from "@/features/project/context/context-files-store";
import { useProjectSurfacePrefsStore } from "@/features/project/layout";
import { isDevAutologinEnabled } from "@/server/dev-auth";

/**
 * Decide where to send an UNAUTHENTICATED request, server-side.
 * Returns `/api/auth/dev-login` when dev-autologin is enabled; otherwise WorkOS sign-in.
 */
const resolveUnauthRedirect = createServerFn({ method: "GET" })
  .inputValidator((data: { returnPathname: string }) => data)
  .handler(async ({ data }): Promise<{ to: string } | { href: string }> => {
    if (isDevAutologinEnabled()) {
      return { to: "/api/auth/dev-login" };
    }

    const href = await getSignInUrl({ data: { returnPathname: data.returnPathname } });
    return { href };
  });

export const Route = createFileRoute("/_authenticated")({
  loader: async ({ location }) => {
    const { user } = await getAuth();
    if (!user) {
      const path = `${location.pathname}${location.searchStr}`;
      const target = await resolveUnauthRedirect({ data: { returnPathname: path } });
      throw redirect(target);
    }

    const currentUser = { userId: user.id, email: user.email ?? null };

    const now = Date.now();
    const usesWorkspaceProviders =
      location.pathname === "/home" ||
      location.pathname.startsWith("/project/") ||
      location.pathname.startsWith("/chat/") ||
      location.pathname.startsWith("/settings/billing");

    if (!usesWorkspaceProviders) {
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
  shouldReload: () => true,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { projects, now } = Route.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const usesWorkspaceProviders =
    pathname === "/home" ||
    pathname.startsWith("/project/") ||
    pathname.startsWith("/chat/") ||
    pathname.startsWith("/settings/billing");

  useEffect(() => {
    if (!usesWorkspaceProviders) return;

    seedContextFilesPanelFromLegacy();
    void useContextFilesPanelStore.persist.rehydrate();
    void useLayoutStore.persist.rehydrate();
    void useIndependentProjectsStore.persist.rehydrate();
    void useProjectSurfacePrefsStore.persist.rehydrate();
    useProjectSurfacePrefsStore.getState().setHydrated();
  }, [usesWorkspaceProviders]);

  if (!usesWorkspaceProviders) {
    return <Outlet />;
  }

  return (
    <AppQueryProvider initialProjects={projects}>
      <ProjectStoreProvider now={now}>
        <ThreadStoreProvider now={now}>
          <TransportProvider>
            <MeridianCopilotProvider>
              <div className="app-frame flex flex-col">
                <ConnectionBanner />
                <div className="min-h-0 flex-1 overflow-hidden">
                  <Outlet key={pathname} />
                </div>
              </div>
              <SettingsDialog />
            </MeridianCopilotProvider>
          </TransportProvider>
        </ThreadStoreProvider>
      </ProjectStoreProvider>
    </AppQueryProvider>
  );
}
