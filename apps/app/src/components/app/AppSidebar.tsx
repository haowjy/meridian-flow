// @ts-nocheck
/**
 * AppSidebar — the persistent desktop app-level navigation sidebar.
 *
 * Brand header, "New workbench" link, date-grouped workbench list, soft-delete undo
 * pill, and account footer. Owns desktop nav chrome only; workbench rows and
 * list sections are delegated to child components.
 */
import { t } from "@lingui/core/macro";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { AccountMenu } from "@/features/account/AccountMenu";
import { MeridianMark } from "./MeridianMark";
import { SidebarUndoPill } from "./SidebarUndoPill";
import { NewWorkbenchLink, WorkbenchListSection } from "./WorkbenchListSection";

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isHome = pathname === "/";

  // strict:false → params may be empty (e.g. on Home), or carry workbenchId on /workbench.
  const params = useParams({ strict: false }) as { workbenchId?: string };
  const activeWorkbenchId = params.workbenchId;

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          className="focus-ring flex items-center gap-2.5 rounded-md px-1 py-1.5 text-foreground no-underline hover:bg-transparent active:bg-transparent"
          aria-label={t`Home`}
          aria-current={isHome ? "page" : undefined}
        >
          <MeridianMark />
          <span className="font-heading text-xl font-semibold tracking-tight">Meridian</span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <NewWorkbenchLink isActive={isHome} />
        <WorkbenchListSection activeWorkbenchId={activeWorkbenchId} />
      </SidebarContent>

      <SidebarUndoPill />

      <SidebarFooter className="border-t border-sidebar-border">
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
