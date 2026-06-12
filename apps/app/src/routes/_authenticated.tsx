// @ts-nocheck
import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { MeridianCopilotProvider } from "@/client/copilot/MeridianCopilotProvider";
import { TransportProvider } from "@/client/providers/TransportProvider";
import { AppQueryProvider } from "@/client/query/AppQueryProvider";
import {
  loadWorkbenchList,
  ThreadStoreProvider,
  useIndependentWorkbenchesStore,
  useLayoutStore,
  WorkbenchStoreProvider,
} from "@/client/stores";
import { ConnectionBanner } from "@/components/app/ConnectionBanner";
import { SettingsDialog } from "@/features/account/SettingsDialog";
import {
  seedContextFilesPanelFromLegacy,
  useContextFilesPanelStore,
} from "@/features/workbench/context/context-files-store";
import { useWorkbenchSurfacePrefsStore } from "@/features/workbench/layout";
import { getCurrentUser } from "@/server/current-user";

export const Route = createFileRoute("/_authenticated")({
  loader: async ({ location }) => {
    const user = await getCurrentUser();
    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: `${location.pathname}${location.searchStr}` },
      });
    }

    const now = Date.now();
    const usesWorkspaceProviders =
      location.pathname.startsWith("/workbench/") || location.pathname.startsWith("/chat/");

    if (!usesWorkspaceProviders) {
      return { user, workbenches: null, now };
    }

    try {
      return { user, workbenches: await loadWorkbenchList(), now };
    } catch (error) {
      console.error("Failed to load workbench list during SSR:", error);
      return { user, workbenches: null, now };
    }
  },
  staleTime: 60_000,
  shouldReload: () => true,
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const { workbenches, now } = Route.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const usesWorkspaceProviders =
    pathname.startsWith("/workbench/") || pathname.startsWith("/chat/");

  useEffect(() => {
    if (!usesWorkspaceProviders) return;

    seedContextFilesPanelFromLegacy();
    void useContextFilesPanelStore.persist.rehydrate();
    void useLayoutStore.persist.rehydrate();
    void useIndependentWorkbenchesStore.persist.rehydrate();
    void useWorkbenchSurfacePrefsStore.persist.rehydrate();
    useWorkbenchSurfacePrefsStore.getState().setHydrated();
  }, [usesWorkspaceProviders]);

  if (!usesWorkspaceProviders) {
    return <Outlet />;
  }

  return (
    <AppQueryProvider initialWorkbenches={workbenches}>
      <WorkbenchStoreProvider now={now}>
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
      </WorkbenchStoreProvider>
    </AppQueryProvider>
  );
}
