/**
 * AppSidebar — the persistent desktop app-level navigation sidebar.
 *
 * Brand header, "New project" link, date-grouped project list, soft-delete undo
 * pill, and account footer. Owns desktop nav chrome only; project rows and
 * list sections are delegated to child components.
 */
import { t } from "@lingui/core/macro";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from "@/components/ui/sidebar";
import { AccountMenu } from "@/features/account/AccountMenu";
import { CreditBalanceBadge } from "@/features/billing/CreditBalanceBadge";
import { MeridianMark } from "./MeridianMark";
import { NewProjectLink, ProjectListSection } from "./ProjectListSection";
import { SidebarUndoPill } from "./SidebarUndoPill";

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isHome = pathname === "/home";

  // strict:false → params may be empty (e.g. on Home), or carry projectId on /project.
  const params = useParams({ strict: false }) as { projectId?: string };
  const activeProjectId = params.projectId;

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <Link
          to="/home"
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
        <NewProjectLink isActive={isHome} />
        <ProjectListSection activeProjectId={activeProjectId} />
      </SidebarContent>

      <SidebarUndoPill />

      <SidebarFooter className="border-t border-sidebar-border">
        <CreditBalanceBadge />
        <AccountMenu />
      </SidebarFooter>
    </Sidebar>
  );
}
