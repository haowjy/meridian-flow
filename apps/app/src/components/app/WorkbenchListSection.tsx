// @ts-nocheck
/**
 * WorkbenchListSection — desktop workbench-list sidebar section.
 *
 * Purpose: keep app-sidebar workbench grouping, loading/empty states, and the
 * "New workbench" action in one desktop-only module. The account row lives
 * in `features/account/AccountMenu`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { useWorkbenchListStatus } from "@/client/query/useWorkbenchList";
import { useIndependentWorkbenchIds, useThreadStore, useWorkbenchStore } from "@/client/stores";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
} from "@/components/ui/sidebar";
import { dateGroupLabel, formatRelativeTime } from "@/lib/date-groups";
import { cn } from "@/lib/utils";
import { groupWorkbenchesByDate } from "@/lib/workbench-groups";
import { QueryErrorRow } from "./QueryErrorRow";
import { WorkbenchRow } from "./WorkbenchRow";

type WorkbenchListSectionProps = {
  activeWorkbenchId?: string;
};

type NewWorkbenchLinkProps = {
  isActive: boolean;
};

function useWorkbenchListSectionData() {
  const { workbenches: allWorkbenches, isError, refetch } = useWorkbenchListStatus();
  const independentIds = useIndependentWorkbenchIds();
  const workbenches =
    allWorkbenches === null
      ? null
      : independentIds.size === 0
        ? allWorkbenches
        : allWorkbenches.filter((p) => !independentIds.has(p.id));
  const now = useWorkbenchStore((s) => s.now);
  const streamingWorkbenchId = useThreadStore((s) => s.streamingWorkbenchId);
  const groups = workbenches === null ? [] : groupWorkbenchesByDate(workbenches, now);

  return { groups, isError, now, workbenches, refetch, streamingWorkbenchId };
}

export function NewWorkbenchLink(props: NewWorkbenchLinkProps) {
  return (
    <div className="px-2 pt-2">
      <Link
        to="/"
        className={cn(
          "focus-ring flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
          props.isActive && "bg-sidebar-accent text-foreground",
        )}
      >
        <Plus className="size-4 shrink-0" aria-hidden />
        <Trans>New workbench</Trans>
      </Link>
    </div>
  );
}

export function WorkbenchListSection(props: WorkbenchListSectionProps) {
  const { groups, isError, now, workbenches, refetch, streamingWorkbenchId } =
    useWorkbenchListSectionData();

  return (
    <nav aria-label={t`Workbenches`}>
      {isError ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <QueryErrorRow onRetry={refetch} />
          </SidebarGroupContent>
        </SidebarGroup>
      ) : workbenches !== null && groups.length > 0 ? (
        groups.map(({ group, workbenches }) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{dateGroupLabel(group)}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {workbenches.map((workbench) => (
                  <WorkbenchRow
                    key={workbench.id}
                    workbench={workbench}
                    isActive={workbench.id === props.activeWorkbenchId}
                    isStreaming={workbench.id === streamingWorkbenchId}
                    timeLabel={formatRelativeTime(workbench.updatedAt, now)}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))
      ) : workbenches !== null && workbenches.length === 0 ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <p className="px-2 py-3 text-sm text-muted-foreground">
              <Trans>No workbenches yet — start one from the Home screen.</Trans>
            </p>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </nav>
  );
}
