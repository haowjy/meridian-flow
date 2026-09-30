/**
 * The Work destination's chrome: the All Work door, the open Work's name as a
 * tab renamed in place, and its `…` actions. The desktop band and the phone
 * top bar both render these pieces. A rejected Archive, Unarchive or Delete is
 * its own `notice`, placed like a rejected chat rename: beside the title in a wide
 * band, on its own full-width line under a narrow band or the phone top bar.
 */
import { t } from "@lingui/core/macro";
import { Layers } from "lucide-react";
import type { AddressableWork } from "@/client/query/useWorks";
import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { IndexTabChip, ReturnTabChip } from "../shell/IndexTabChip";
import { isWorkReadOnly } from "./archived-work";
import { useWorkArchiveToggle } from "./useWorkArchiveToggle";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkActionsMenu } from "./WorkActionsMenu";
import { WORK_ROW_OPERATIONS, WorkCommandFailureRow } from "./WorkCommandFailureRow";
import { PlainWorkTitleTab, WorkTitleTab } from "./WorkTitles";

/** The Work destination's chrome pieces, shared by the desktop band and the phone top bar. */
export function useWorkChrome(
  projectId: string,
  routeWork: RouteWorkResolution,
  rememberedWork: AddressableWork | null,
  routeCommands: ProjectRouteCommands,
  deletion: WorkDeletion,
  /** `tab` in the desktop band; `quiet` in the phone top bar's trail. */
  variant: "tab" | "quiet",
) {
  const toggleArchive = useWorkArchiveToggle(projectId);
  const failures = useWorkCommandFailures(projectId, WORK_ROW_OPERATIONS);
  const onCollection = routeWork.status === "none" || routeWork.status === "new";
  const pendingName = routeWork.status === "creating" ? routeWork.name : undefined;
  const openCollection = () => {
    void routeCommands.closeWork({ replace: false });
  };
  const work = routeWork.status === "present" ? routeWork.work : null;
  const remembered = onCollection ? rememberedWork : null;
  const failure = work ? failures.get(work.id) : undefined;
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
    notice:
      work && failure ? (
        <WorkCommandFailureRow
          failure={failure}
          // Retrying a delete here leaves the Work page, as the delete did.
          onRetry={
            failure.operation === "delete" ? () => deletion.remove(work, "detail") : undefined
          }
        />
      ) : null,
    title: work ? (
      isWorkReadOnly(work) ? (
        <PlainWorkTitleTab key={work.id} name={work.name} variant={variant} />
      ) : (
        <WorkTitleTab key={work.id} projectId={projectId} work={work} variant={variant} />
      )
    ) : pendingName ? (
      <PlainWorkTitleTab name={pendingName} variant={variant} />
    ) : remembered && variant === "tab" ? (
      <ReturnTabChip
        title={remembered.name}
        onClick={() =>
          void routeCommands.openWork(
            { kind: "work-detail", workId: remembered.id },
            { replace: false },
          )
        }
      />
    ) : null,
    actions: work ? (
      <WorkActionsMenu
        work={work}
        onToggleArchive={() => void toggleArchive(work)}
        onDelete={() => deletion.remove(work, "detail")}
      />
    ) : null,
  };
}
