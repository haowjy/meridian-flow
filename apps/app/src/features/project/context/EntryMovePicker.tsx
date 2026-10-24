/** Row-anchored folder placement using the same project tree as document paths. */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ResourceDestination } from "@meridian/resource-replica";
import { FolderInput } from "lucide-react";
import { type ReactNode, type RefObject, useMemo, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { TabOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Button } from "@/components/ui/button";
import { useAccountResourceReplica } from "./account-feature-context";
import { moveEntryName } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import { useReportMove } from "./entry-drag/use-entry-list";
import {
  destinationParent,
  type MoveDestination,
  type MoveSubject,
  moveRefusal,
  placeEntry,
} from "./move-entry";
import { moveRepairTrail } from "./move-repair-trail";
import { useProjectMenuSource } from "./use-project-menu-source";

type MoveEntry = Pick<MoveSubject, "id" | "name" | "path" | "kind">;

type EntryMovePickerProps = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: TabOwner;
  entry: MoveEntry;
  open: boolean;
  repairMove?: ResourceDestination;
  onOpenChange: (open: boolean) => void;
  onMoved: (operationId: string) => void;
  children: ReactNode;
};

export function EntryMovePicker({ children, ...props }: EntryMovePickerProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="relative">
      {children}
      {props.open ? <OpenMovePicker {...props} rowRef={rowRef} /> : null}
    </div>
  );
}

/** Closed rows keep their anchor but do not subscribe to any project catalog. */
function OpenMovePicker({
  projectId,
  scheme,
  owner,
  entry,
  open,
  repairMove,
  onOpenChange,
  onMoved,
  rowRef,
}: Omit<EntryMovePickerProps, "children"> & { rowRef: RefObject<HTMLDivElement | null> }) {
  const resources = useAccountResourceReplica();
  const reportMove = useReportMove();
  const { works, noWork } = useWorks(projectId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const document = useMemo(
    () => ({ scheme, owner, heading: schemeLabel(scheme) }),
    [scheme, owner],
  );
  const scratch = useMemo(
    () => (scheme === "scratch" ? { owner, heading: schemeLabel(scheme) } : null),
    [scheme, owner],
  );
  const source = useProjectMenuSource({ projectId, title: "", document, scratch });
  const currentTrail = source.own.openAt(entry.path);
  const currentParentId = currentTrail.at(-1)?.id;
  const openAt = (repairMove && moveRepairTrail(source, repairMove, currentTrail)) || currentTrail;
  const name = moveEntryName(entry.name, repairMove);
  const failedFolder = repairMove
    ? repairMove.parent.kind === "root"
      ? schemeLabel(repairMove.parent.scheme)
      : (source.folderFor(repairMove.parent.folderId)?.path.split("/").at(-1) ?? t`that folder`)
    : null;
  const refusal = failedFolder
    ? t`Couldn't move to ${failedFolder}. Try again or pick another folder.`
    : null;
  const unavailable = t`This location is unavailable. Refresh and try again.`;

  const subject: MoveSubject = {
    ...entry,
    catalogRootId: source.own.catalog?.root.entryId ?? null,
    parentId: (currentParentId && source.folderFor(currentParentId)?.entryId) ?? null,
  };
  const isForbidden = (destination: MoveDestination) =>
    moveRefusal(subject, destination)?.kind === "inside-itself";

  async function move(trail: readonly DrillNode[]) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!destination || pending || moveRefusal(subject, destination)) return;
    setPending(true);
    setError(null);
    try {
      const parent = destinationParent(destination, works, noWork);
      if (!parent) throw new Error(unavailable);
      const placed = await placeEntry(
        resources,
        projectId,
        entry,
        parent,
        destination.catalog.children(destination.entryId),
        name,
      );
      if (placed.operationId) onMoved(placed.operationId);
      // In a list, Move… ends like a drop: the row selected and the notice with Undo.
      const current = currentParentId ? source.folderFor(currentParentId) : null;
      const before = current ? destinationParent(current, works, noWork) : null;
      const ref = { kind: entry.kind, id: entry.id };
      if (reportMove && before)
        reportMove(
          {
            moved: [
              { entry: ref, name: placed.name, previousName: entry.name, before, after: parent },
            ],
            failed: [],
          },
          folder.name,
        );
      onOpenChange(false);
    } catch {
      setError(unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <DrillInMenu
      // Catalog acquisition may resolve the initial destination after this open picker mounts.
      key={openAt.map((node) => node.id).join("/")}
      tree={source.tree}
      hereIds={currentTrail.map((node) => node.id)}
      openAt={openAt}
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        rowRef.current
          ?.querySelector<HTMLElement>('button[data-slot="icon-button"], [role="button"]')
          ?.focus();
      }}
      caption={t`Move ${name}`}
      status={error ?? refusal}
      isDisabled={(node) => {
        if (!node.folder) return true;
        const folder = source.folderFor(node.id);
        return !folder || isForbidden(folder);
      }}
      onPick={() => undefined}
      actions={(trail) => {
        const folder = trail.at(-1);
        if (!folder) return [];
        const destination = source.folderFor(folder.id);
        if (!destination || isForbidden(destination)) return [];
        const already = folder.id === currentParentId;
        return [
          {
            key: "move",
            icon: FolderInput,
            label: already ? t`Already in ${folder.name}` : t`Move to ${folder.name}`,
            disabled: already || pending,
            onSelect: () => {
              void move(trail);
            },
          },
        ];
      }}
    >
      {/* Radix DropdownMenu has no standalone anchor. This inert trigger positions the externally opened picker at the row actions. */}
      <Button
        variant="quiet"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute right-2 bottom-0 h-0 w-8 p-0 opacity-0"
      />
    </DrillInMenu>
  );
}
