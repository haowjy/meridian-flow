/**
 * The Work destination's chrome: the All Work door, the open Work's name as a
 * tab renamed in place, and its `…` actions. The desktop band and the phone
 * top bar both render these pieces.
 */
import { t } from "@lingui/core/macro";
import { parseRequestId } from "@meridian/contracts/request-id";
import { Layers } from "lucide-react";
import { readCurrentWork } from "@/client/current-work";
import { useWorks } from "@/client/query/useWorks";
import { useAccountId } from "../context/account-feature-context";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { IndexTabChip, ReturnTabChip } from "../shell/IndexTabChip";
import { routeWorkIdentity } from "./route-work-identity";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import { useWorkCreationRecords } from "./useWorkCreation";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { PendingWorkTitleTab, WorkTitleTab } from "./WorkTitles";

/** The Work destination's chrome pieces, shared by the desktop band and the phone top bar. */
export function useWorkChrome(
  projectId: string,
  routeWork: RouteWorkResolution,
  routeCommands: ProjectRouteCommands,
  onDelete: WorkDeletion["remove"],
  /** `tab` in the desktop band; `quiet` in the phone top bar's trail. */
  variant: "tab" | "quiet",
) {
  const archiveToggle = useWorkArchiveToggle(projectId);
  const creations = useWorkCreationRecords(projectId);
  const onCollection = routeWork.status === "none" || routeWork.status === "new";
  const pendingId = routeWork.status === "unresolved" ? routeWorkIdentity(routeWork) : null;
  const pendingName = pendingId
    ? creations.find((creation) => creation.workId === pendingId)?.request.name
    : undefined;
  const openCollection = () => {
    void routeCommands.closeWork({ replace: false });
  };
  const work = routeWork.status === "present" ? routeWork.work : null;
  // On the collection, the last opened Work waits as a tab back, like the
  // current chat beside the chat index.
  const accountId = useAccountId();
  const works = useWorks(projectId).works;
  const rememberedId = onCollection ? readCurrentWork(accountId, projectId) : null;
  const remembered = rememberedId
    ? (works?.find((entry) => entry.id === rememberedId) ?? null)
    : null;
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
