/**
 * Row-anchored folder placement using the same project tree as document paths. One picker for
 * Move… and Copy to…: both offer the same destinations (a folder cannot go inside itself), and
 * differ in what picking does. Move… takes one row and offers its position among the folder's
 * siblings; Copy to… takes any rows (the refusal notice sends back all of a refused Copy's) and
 * always adds.
 */
import { plural, t } from "@lingui/core/macro";
import type {
  ContextSiblingPosition,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { ParentRef, ResourceDestination } from "@meridian/resource-replica";
import {
  ArrowDownToLine,
  ArrowDownUp,
  ArrowUpToLine,
  Copy,
  CornerDownRight,
  FolderInput,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, type RefObject, useMemo, useRef, useState } from "react";
import { useWorks } from "@/client/query/useWorks";
import type { TabOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Button } from "@/components/ui/button";
import { useAccountResourceProjection, useAccountResourceReplica } from "./account-feature-context";
import { moveEntryName } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import { copyOperation } from "./entry-drag/copy-operation";
import { describeRenames } from "./entry-drag/drop-choice";
import { LIVE_VIEW } from "./entry-drag/entry";
import { copyArrivals, copyRows } from "./entry-drag/execute-copy";
import { moveRows, renamesOnArrival } from "./entry-drag/execute-move";
import { moveOperation } from "./entry-drag/move-operation";
import { moveRefusal, parentOf, type ReadyCopy, sameParent } from "./entry-drag/move-plan";
import { useOperationFeedback } from "./entry-drag/operation-notice";
import { destinationParent, type MoveDestination } from "./move-entry";
import { moveRepairTrail } from "./move-repair-trail";
import { useProjectMenuSource } from "./use-project-menu-source";

export type PickedEntry = { kind: "file" | "folder"; id: string; name: string; path: string };

type EntryDestinationPickerProps = {
  projectId: string;
  action: "move" | "copy";
  /** The area the rows sit in, which the menu opens at; absent opens at the project's root. */
  from?: { scheme: ProjectContextTreeScheme; owner: TabOwner };
  /** Move… takes exactly one row. */
  entries: readonly PickedEntry[];
  open: boolean;
  repairMove?: ResourceDestination;
  onOpenChange: (open: boolean) => void;
  /** A Copy was admitted from this pick. */
  onPicked?: () => void;
  children: ReactNode;
};

export function EntryDestinationPicker({ children, ...props }: EntryDestinationPickerProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className="relative">
      {children}
      {props.open ? <OpenPicker {...props} rowRef={rowRef} /> : null}
    </div>
  );
}

/** Closed rows keep their anchor but do not subscribe to any project catalog. */
function OpenPicker({
  projectId,
  action,
  from,
  entries,
  open,
  repairMove,
  onOpenChange,
  onPicked,
  rowRef,
}: Omit<EntryDestinationPickerProps, "children"> & { rowRef: RefObject<HTMLDivElement | null> }) {
  const resources = useAccountResourceReplica();
  const { surface, publish } = useOperationFeedback();
  const view = useAccountResourceProjection(projectId);
  const { works, noWork } = useWorks(projectId);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const scheme = from?.scheme;
  const owner = from?.owner;
  const own = useMemo(
    () => (scheme && owner ? { scheme, owner, heading: schemeLabel(scheme) } : null),
    [scheme, owner],
  );
  const scratch = useMemo(
    () => (scheme === "scratch" && owner ? { owner, heading: schemeLabel(scheme) } : null),
    [scheme, owner],
  );
  const source = useProjectMenuSource({ projectId, title: "", own, scratch });
  const [entry] = entries;
  if (!entry) return null;
  const currentTrail = own ? source.own.openAt(entry.path) : [];
  const openAt = (repairMove && moveRepairTrail(source, repairMove, currentTrail)) || currentTrail;
  const name = moveEntryName(entry.name, repairMove);
  // The caption names the row as the list shows it; a retry may carry a refused name.
  const rowName = entry.name;
  const failedFolder =
    action === "move" && repairMove
      ? repairMove.parent.kind === "root"
        ? schemeLabel(repairMove.parent.scheme)
        : (source.folderFor(repairMove.parent.folderId)?.path.split("/").at(-1) ?? t`that folder`)
      : null;
  const refusal = failedFolder
    ? t`Couldn't move to ${failedFolder}. Try again or pick another folder.`
    : null;
  const unavailable = t`This location is unavailable. Refresh and try again.`;

  const ref = { kind: entry.kind, id: entry.id };
  const refusalAt = (destination: MoveDestination) => {
    const into = destinationParent(destination, works, noWork);
    if (!into) return null;
    // Copy adds beside what is there, so only a folder inside itself refuses.
    if (action === "copy")
      return entries.some(
        (picked) =>
          picked.kind === "folder" &&
          moveRefusal(view, { kind: picked.kind, id: picked.id }, into) === "inside-itself",
      )
        ? "inside-itself"
        : null;
    const position =
      repairMove && sameParent(repairMove.parent, into) ? repairMove.position : undefined;
    return moveRefusal(view, ref, into, position);
  };

  /**
   * Every other place among its own siblings, in the parent's complete order
   * (not what a search shows): the top, after each sibling, the bottom. The
   * place it already holds is not offered.
   */
  function positionChoices(folderName: string) {
    const parent = parentOf(view, ref);
    if (!parent) return [];
    const siblings = view.placement.childrenAt(parent, view.records);
    const at = siblings.findIndex((sibling) => sibling.entryId === entry.id);
    if (at < 0) return [];
    const others = siblings.filter((sibling) => sibling.entryId !== entry.id);
    const choices: {
      key: string;
      icon: LucideIcon;
      label: string;
      position: ContextSiblingPosition;
    }[] = [];
    if (at > 0)
      choices.push({
        key: "start",
        icon: ArrowUpToLine,
        label: t`Move to the top of ${folderName}`,
        position: { kind: "start" },
      });
    others.forEach((other, index) => {
      // After the row just above it is where it already is.
      if (index === at - 1) return;
      const sibling = other.name;
      choices.push(
        index === others.length - 1
          ? {
              key: "end",
              icon: ArrowDownToLine,
              label: t`Move to the bottom of ${folderName}`,
              position: { kind: "end" },
            }
          : {
              key: `after:${other.entryId}`,
              icon: CornerDownRight,
              label: t`Move after ${sibling}`,
              position: { kind: "after", siblingId: other.entryId },
            },
      );
    });
    return choices;
  }

  async function move(trail: readonly DrillNode[], chosen?: ContextSiblingPosition) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!destination || pending || (!chosen && refusalAt(destination))) return;
    setPending(true);
    setError(null);
    try {
      const after = destinationParent(destination, works, noWork);
      const before = parentOf(view, ref);
      if (!after || !before) throw new Error(unavailable);
      const position =
        chosen ??
        (repairMove && sameParent(repairMove.parent, after) ? repairMove.position : undefined);
      const result = await moveRows(
        [
          {
            entry: ref,
            name: entry.name,
            typed: name,
            before,
            after,
            ...(position ? { position } : {}),
          },
        ],
        { resources, projectId },
      );
      if (result.failed.length > 0) throw new Error(unavailable);
      publish(moveOperation(result, folder.name));
      onOpenChange(false);
    } catch {
      setError(unavailable);
    } finally {
      setPending(false);
    }
  }

  /** Copies every picked row into the folder at the end of `trail`, then reports like a drop does. */
  async function copy(trail: readonly DrillNode[]) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    const into = destination && destinationParent(destination, works, noWork);
    if (!destination || !into || pending || refusalAt(destination)) return;
    setPending(true);
    setError(null);
    try {
      const result = await copyRows(
        copyPlan(destination.scheme, into, folder.name),
        { resources, projectId },
        surface,
      );
      if (!result) throw new Error(unavailable);
      publish(copyOperation(result));
      onPicked?.();
      onOpenChange(false);
    } catch {
      setError(unavailable);
    } finally {
      setPending(false);
    }
  }

  const copyPlan = (
    scheme: ProjectContextTreeScheme,
    into: ParentRef,
    destinationName: string,
  ): ReadyCopy => ({
    kind: "ready",
    destinationName,
    scheme,
    into,
    copies: entries.map((picked) => ({
      entry: { kind: picked.kind, id: picked.id },
      name: picked.name,
      view: LIVE_VIEW,
    })),
  });

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
      caption={
        action === "copy"
          ? entries.length === 1
            ? t`Copy ${rowName}`
            : plural(entries.length, { one: "Copy # item", other: "Copy # items" })
          : t`Move ${rowName}`
      }
      status={error ?? refusal}
      isDisabled={(node) => {
        if (!node.folder) return true;
        const folder = source.folderFor(node.id);
        return !folder || refusalAt(folder) === "inside-itself";
      }}
      onPick={() => undefined}
      actions={(trail) => {
        const folder = trail.at(-1);
        if (!folder) return [];
        const destination = source.folderFor(folder.id);
        const blocked = destination ? refusalAt(destination) : "inside-itself";
        if (blocked === "inside-itself") return [];
        if (action === "copy") {
          const into = destination && destinationParent(destination, works, noWork);
          const renamed =
            destination && into
              ? renamesOnArrival(
                  copyArrivals(copyPlan(destination.scheme, into, folder.name)),
                  view,
                )
              : [];
          return [
            {
              key: "copy",
              icon: Copy,
              label: t`Copy to ${folder.name}`,
              disabled: pending,
              note: describeRenames(renamed),
              onSelect: () => {
                void copy(trail);
              },
            },
          ];
        }
        const already = blocked === "already-there";
        const positions = already ? positionChoices(folder.name) : [];
        if (positions.length > 0)
          return [
            {
              key: "position",
              icon: ArrowDownUp,
              label: t`Change position in ${folder.name}`,
              disabled: pending,
              onSelect: () => undefined,
              choices: positions.map((choice) => ({
                ...choice,
                disabled: pending,
                onSelect: () => {
                  void move(trail, choice.position);
                },
              })),
            },
          ];
        const after = destination && !already && destinationParent(destination, works, noWork);
        const renamed = after
          ? renamesOnArrival([{ entry: ref, name: entry.name, typed: name, after }], view)
          : [];
        return [
          {
            key: "move",
            icon: FolderInput,
            label: already ? t`Already in ${folder.name}` : t`Move to ${folder.name}`,
            disabled: already || pending,
            note: describeRenames(renamed),
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
