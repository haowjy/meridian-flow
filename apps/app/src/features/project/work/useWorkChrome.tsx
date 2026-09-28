/**
 * The Work destination's chrome: the All Work door, the open Work's name as a
 * tab renamed in place, and its `…` actions. The desktop band and the phone
 * top bar both render these pieces.
 */
import { t } from "@lingui/core/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import { Layers } from "lucide-react";
import { useWorkMutations } from "@/client/query/useWorks";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { IndexTabChip } from "../shell/IndexTabChip";
import { useWorkCreationRecords } from "./useWorkCreation";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { PendingWorkTitleTab, WorkTitleTab } from "./WorkTitleTab";
import { holdWorkCollectionFocus } from "./work-focus-intent";

/** The Work destination's chrome pieces, shared by the desktop band and the phone top bar. */
export function useWorkChrome(
  projectId: string,
  routeWork: RouteWorkResolution,
  routeCommands: ProjectRouteCommands,
  onDelete: WorkDeletion["remove"],
  /** `tab` in the desktop band; `quiet` in the phone top bar's trail. */
  variant: "tab" | "quiet",
) {
  const mutations = useWorkMutations(projectId);
  const creations = useWorkCreationRecords(projectId);
  const onCollection = routeWork.status === "none" || routeWork.status === "new";
  const pendingId = routeWork.status === "unresolved" ? parseRequestId(routeWork.slug) : null;
  const pendingName = pendingId
    ? creations.find((creation) => creation.workId === pendingId)?.request.name
    : undefined;
  const openCollection = () => {
    holdWorkCollectionFocus(projectId, { kind: "heading" });
    void routeCommands.closeWork({ replace: false });
  };
  const work = routeWork.status === "present" ? routeWork.work : null;
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
    ) : null,
    actions: work ? (
      <WorkActionsMenu
        work={work}
        disabled={mutations.isPending}
        onToggleArchive={() =>
          (work.status === "archived" ? mutations.unarchive : mutations.archive).mutate(work.id)
        }
        onDelete={() => onDelete(work, "detail")}
      />
    ) : null,
  };
}
