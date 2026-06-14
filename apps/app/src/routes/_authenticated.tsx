// @ts-nocheck
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
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
import { getCurrentUser } from "@/server/current-user";
import { resolveOnboardingGate, shouldRedirectToOnboarding } from "@/server/onboarding-gate";

export const Route = createFileRoute("/_authenticated")({
  loader: async ({ location }) => {
    const user = await getCurrentUser();
    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }

    const onboardingGate = await resolveOnboardingGate();
    if (!onboardingGate.ok && location.pathname !== "/onboarding") {
      throw redirect({ to: "/onboarding" });
    }
    if (onboardingGate.ok && shouldRedirectToOnboarding(onboardingGate.status, location.pathname)) {
      throw redirect({ to: "/onboarding" });
    }

    const now = Date.now();
    const usesWorkspaceProviders =
      location.pathname === "/" ||
      location.pathname.startsWith("/project/") ||
      location.pathname.startsWith("/chat/") ||
      location.pathname.startsWith("/settings/billing");

    if (!usesWorkspaceProviders) {
      return { user, projects: null, now };
    }

    try {
      return { user, projects: await loadProjectList(), now };
    } catch (error) {
      console.error("Failed to load project list during SSR:", error);
      return { user, projects: null, now };
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
    pathname === "/" ||
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
