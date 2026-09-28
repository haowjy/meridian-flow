/**
 * The Work destination's chrome: the All Work door, the open Work's name as a
 * tab renamed in place, and its `…` actions. The desktop band and the phone
 * top bar both render these pieces.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { Layers } from "lucide-react";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { IndexTabChip, ReturnTabChip } from "../shell/IndexTabChip";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { PendingWorkTitleTab, WorkTitleTab } from "./WorkTitles";

/** The Work destination's chrome pieces, shared by the desktop band and the phone top bar. */
export function useWorkChrome(
  projectId: string,
  routeWork: RouteWorkResolution,
  rememberedWork: Work | null,
  routeCommands: ProjectRouteCommands,
  onDelete: WorkDeletion["remove"],
  /** `tab` in the desktop band; `quiet` in the phone top bar's trail. */
  variant: "tab" | "quiet",
) {
  const archiveToggle = useWorkArchiveToggle(projectId);
  const onCollection = routeWork.status === "none" || routeWork.status === "new";
  const pendingName = routeWork.status === "creating" ? routeWork.name : undefined;
  const openCollection = () => {
    void routeCommands.closeWork({ replace: false });
  };
  const work = routeWork.status === "present" ? routeWork.work : null;
  const remembered = onCollection ? rememberedWork : null;
  return {
    onCollection,
    openCollection,
    name: work?.name ?? pendingName ?? null,
    door: (
      <IndexTabChip
        icon={Layers}
        label={t`All Work`}
        active={onCollection}
        onClick={onCollection ? undefined : openCollection}
      />
    ),
    title: work ? (
      <WorkTitleTab key={work.id} projectId={projectId} work={work} variant={variant} />
    ) : pendingName ? (
      <PendingWorkTitleTab name={pendingName} variant={variant} />
    ) : remembered && variant === "tab" ? (
      <ReturnTabChip
        title={remembered.name}
        onClick={() => {
          const workId = parseRequestId(remembered.id);
          if (workId)
            void routeCommands.openWork({ kind: "work-detail", workId }, { replace: false });
        }}
      />
    ) : null,
    actions: work ? (
      <WorkActionsMenu
        work={work}
        disabled={archiveToggle.isPending}
        onToggleArchive={() => archiveToggle.toggle(work)}
        onDelete={() => onDelete(work, "detail")}
      />
    ) : null,
  };
}
