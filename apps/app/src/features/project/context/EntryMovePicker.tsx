/** Row-anchored folder placement using the same project tree as document paths. */
import { t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { ResourceDestination } from "@meridian/resource-replica";
import { FolderInput } from "lucide-react";
import { type ReactNode, type RefObject, useMemo, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { TabOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Button } from "@/components/ui/button";
import { useAccountResourceReplica } from "./account-feature-context";
import { moveEntryName, validateContextEntryName } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import { destinationOwner } from "./identity-location";
import { rememberRenameOperation } from "./LinkUpdateNote";
import { isFolderWithin } from "./menu-tree";
import { useProjectMenuSource } from "./use-catalog-menu-source";

export type MoveEntry = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
};

type EntryMovePickerProps = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  owner: TabOwner;
  entry: MoveEntry;
  open: boolean;
  repairMove?: ResourceDestination;
  onOpenChange: (open: boolean) => void;
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
  rowRef,
}: Omit<EntryMovePickerProps, "children"> & { rowRef: RefObject<HTMLDivElement | null> }) {
  const resources = useAccountResourceReplica();
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
  const openAt = source.own.openAt(entry.path);
  const currentParentId = openAt.at(-1)?.id;
  const name = moveEntryName(entry.name, repairMove);
  const failedFolder = repairMove
    ? (repairMove.folderPath.split("/").filter(Boolean).at(-1) ?? schemeLabel(repairMove.scheme))
    : null;
  const refusal = failedFolder
    ? t`Couldn't move to ${failedFolder}. Try again or pick another folder.`
    : null;
  const unavailable = t`This location is unavailable. Refresh and try again.`;

  const isForbidden = (folder: NonNullable<ReturnType<typeof source.folderFor>>) =>
    entry.kind === "folder" &&
    folder.catalog === source.own.catalog &&
    isFolderWithin(folder.path, entry.path);

  async function move(trail: readonly DrillNode[]) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!destination || isForbidden(destination) || folder.id === currentParentId || pending)
      return;
    const collision = validateContextEntryName(
      name,
      destination.catalog.children(destination.entryId).map((node) => node.name),
      entry.kind,
    );
    if (collision?.level === "error") {
      setError(collision.message);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const parsed = parseContextUri(destination.catalog.root.uri);
      const targetOwner: TabOwner =
        destination.owner.rootThreadId && parsed.ok && parsed.value.authority.kind === "lineage"
          ? {
              rootThreadId: destination.owner.rootThreadId,
              rootThreadRef: parsed.value.authority.rootThreadRef,
            }
          : { workId: destination.owner.workId ?? undefined };
      const authority = destinationOwner(
        { scheme: destination.scheme, ...targetOwner },
        works,
        noWork,
      );
      if (!authority) throw new Error(unavailable);
      const location = {
        scheme: destination.scheme,
        folderPath: destination.path === "/" ? "" : destination.path,
        name,
        ...authority,
      };
      const result =
        entry.kind === "folder"
          ? await resources.setFolderLocation(projectId, entry.id, location)
          : await (async () => {
              const key = await resources.keyForDocument(projectId, entry.id);
              if (!key) throw new Error(unavailable);
              return resources.setLocation(projectId, key, location);
            })();
      if (result.operationId) rememberRenameOperation(entry.id, result.operationId, folder.name);
      onOpenChange(false);
    } catch {
      setError(unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <DrillInMenu
      tree={source.tree}
      hereIds={openAt.map((node) => node.id)}
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
            keepOpen: true,
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
