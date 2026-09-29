/**
 * The Work destination's chrome: the All Work door, the open Work's name as a
 * tab renamed in place, and its `…` actions. The desktop band and the phone
 * top bar both render these pieces. A rejected Archive or Unarchive shows
 * beside the title, like a rejected chat rename in the chat header.
 */
import { t } from "@lingui/core/macro";
import type { Work } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { Layers } from "lucide-react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
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
  const archiveFailure =
    work && archiveToggle.failure?.workId === work.id ? archiveToggle.failure : null;
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
      <>
        <WorkTitleTab key={work.id} projectId={projectId} work={work} variant={variant} />
        {archiveFailure ? (
          <div className="min-w-0">
            <InlineErrorRow
              message={
                archiveFailure.operation === "archive"
                  ? t`Work couldn’t be archived`
                  : t`Work couldn’t be unarchived`
              }
              onRetry={() => archiveToggle.retry()}
              actionLabel={t`Retry`}
              onDismiss={archiveToggle.dismiss}
            />
          </div>
        ) : null}
      </>
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
        onToggleArchive={() => archiveToggle.toggle(work)}
        onDelete={() => onDelete(work, "detail")}
      />
    ) : null,
  };
}
