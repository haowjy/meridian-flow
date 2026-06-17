/**
 * ProjectListSection — desktop project-list sidebar section.
 *
 * Purpose: keep app-sidebar project grouping, loading/empty states, and the
 * "New project" action in one desktop-only module. The account row lives
 * in `features/account/AccountMenu`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { useProjectListStatus } from "@/client/query/useProjectList";
import { useIndependentProjectIds, useProjectStore, useThreadStore } from "@/client/stores";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { dateGroupLabel, formatRelativeTime } from "@/lib/date-groups";
import { groupProjectsByDate } from "@/lib/project-groups";
import { cn } from "@/lib/utils";
import { ProjectRow } from "./ProjectRow";
import { QueryErrorRow } from "./QueryErrorRow";

type ProjectListSectionProps = {
  activeProjectId?: string;
};

type NewProjectLinkProps = {
  isActive: boolean;
};

function useProjectListSectionData() {
  const { projects: allProjects, isError, refetch } = useProjectListStatus();
  const independentIds = useIndependentProjectIds();
  const projects =
    allProjects === null
      ? null
      : independentIds.size === 0
        ? allProjects
        : allProjects.filter((p) => !independentIds.has(p.id));
  const now = useProjectStore((s) => s.now);
  const streamingProjectId = useThreadStore((s) => s.streamingProjectId);
  const groups = projects === null ? [] : groupProjectsByDate(projects, now);

  return { groups, isError, now, projects, refetch, streamingProjectId };
}

export function NewProjectLink(props: NewProjectLinkProps) {
  return (
    <div className="px-2 pt-2">
      <Link
        to="/home"
        className={cn(
          "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
          props.isActive && "bg-sidebar-accent text-foreground",
        )}
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        <Trans>New project</Trans>
      </Link>
    </div>
  );
}

export function ProjectListSection(props: ProjectListSectionProps) {
  const { groups, isError, now, projects, refetch, streamingProjectId } =
    useProjectListSectionData();

  return (
    <nav aria-label={t`Projects`}>
      {isError ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <QueryErrorRow onRetry={refetch} />
          </SidebarGroupContent>
        </SidebarGroup>
      ) : projects !== null && groups.length > 0 ? (
        groups.map(({ group, projects }) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{dateGroupLabel(group)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    isActive={project.id === props.activeProjectId}
                    isStreaming={project.id === streamingProjectId}
                    timeLabel={formatRelativeTime(project.updatedAt, now)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))
      ) : projects !== null && projects.length === 0 ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <p className="px-2 py-3 text-sm text-muted-foreground">
              <Trans>No projects yet — start one from the Home screen.</Trans>
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </nav>
  );
}
