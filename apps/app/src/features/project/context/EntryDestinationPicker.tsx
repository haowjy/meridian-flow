import type { DraftOwnerKey } from "@meridian/contracts";
/**
 * Row-anchored folder placement using the same project tree as document paths. One picker for
 * Move… and Copy to…. Move… offers the places in the row's own list (the project's files, or the
 * account's Your files) and the row's position among the folder's siblings; Copy to… offers every
 * place and always adds. A list is the unit of history, so between two the action is Copy: a
 * selection in both lists is offered Copy to…, never Move… (`ContextEntryActions`). Given a
 * selection, Move… moves all of it, each row inside a moved folder going with its folder, and
 * offers no positions.
 */

import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
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
import { useTreeActions } from "@/client/query/useTreeActions";
import type { OpenDocumentOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Button } from "@/components/ui/button";
import { useShellTreeVersion } from "../tree-version";
import { useOptionalLiveDocumentSessionRegistry } from "./account-feature-context";
import { schemeLabel } from "./context-schemes";
import { type DragEntry, type EntryRef, LIVE_VIEW } from "./entry-drag/entry";
import { copySettledNotice } from "./entry-drag/entry-failure";
import { copyRows } from "./entry-drag/execute-copy";
import type { ReadyCopy } from "./entry-drag/move-plan";
import { selectRows, useOptionalEntrySelection } from "./entry-drag/selection";
import { revealFolder } from "./tree-reveal";
import { useProjectMenuSource } from "./use-project-menu-source";
import { useScopeScratchSource } from "./use-scratch-trees";

export type PickedEntry = {
  kind: "file" | "folder";
  id: string;
  name: string;
  path: string;
};

type EntryDestinationPickerProps = {
  projectId: string;
  action: "move" | "copy";
  /** The area the rows sit in, which the menu opens at; absent opens at the project's root. */
  from?: { scheme: ProjectContextTreeScheme; owner: OpenDocumentOwner };
  /** The row the picker opened from: it opens beside it, at its folder. */
  entry: PickedEntry;
  /** A selection the row's menu acted on, moved together in screen order; absent moves the row alone. */
  selection?: readonly DragEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

function OpenPicker({
  projectId,
  action,
  from,
  entry,
  selection: picked,
  open,
  onOpenChange,
  rowRef,
}: Omit<EntryDestinationPickerProps, "children"> & { rowRef: RefObject<HTMLDivElement | null> }) {
  const shell = useShellTreeVersion();
  const projectActions = useTreeActions({ kind: "project", projectId });
  const accountActions = useTreeActions({ kind: "account" });
  const selection = useOptionalEntrySelection();
  const registry = useOptionalLiveDocumentSessionRegistry();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A moved selection keeps focus at its first row in its new place, not at the row it left.
  const movedSeveral = useRef(false);
  const scheme = from?.scheme;
  const owner = from?.owner;
  const own = useMemo(
    () => (scheme && owner ? { scheme, owner, heading: schemeLabel(scheme) } : null),
    [scheme, owner],
  );
  // A Scratch row's own Scratch, else the picked Work's, as the sidebar lists it.
  const scopeScratch = useScopeScratchSource(projectId);
  const scratch = useMemo(
    () => (scheme === "scratch" && owner ? { owner, heading: schemeLabel(scheme) } : scopeScratch),
    [scheme, owner, scopeScratch],
  );
  const source = useProjectMenuSource({ projectId, title: "", own, scratch });
  const openAt = own ? source.own.openAt(entry.path) : [];
  const unavailable = t`This location is unavailable. Refresh and try again.`;

  const several = picked !== undefined && picked.length > 1;
  // A row inside a selected folder goes with that folder, never on its own.
  const subjects = useMemo(() => {
    const rows: { ref: EntryRef; name: string; view: DragEntry["view"] }[] = several
      ? picked.map((row) => ({ ref: row.ref, name: row.name, view: row.view }))
      : [
          {
            ref: { kind: entry.kind, id: entry.id },
            name: entry.name,
            view:
              shell?.showing === "draft"
                ? {
                    kind: "draft",
                    owner: shell.ownerKey as DraftOwnerKey,
                  }
                : LIVE_VIEW,
          },
        ];
    const inside = new Set(
      rows.flatMap((row) => {
        const found = row.ref.kind === "folder" ? source.locate(row.ref.id) : null;
        return found ? found.tree.descendants(row.ref.id) : [];
      }),
    );
    return rows.filter((row) => !inside.has(row.ref.id));
  }, [several, picked, entry.kind, entry.id, entry.name, source, shell]);
  const placed = subjects.map((row) => ({ row, at: source.locate(row.ref.id) }));

  /** Why a destination is no place for the subjects, if it is not. */
  const refusalAt = (destination: NonNullable<ReturnType<typeof source.folderFor>>) => {
    for (const { row, at } of placed) {
      if (
        at &&
        row.ref.kind === "folder" &&
        (destination.entryId === row.ref.id ||
          at.tree.descendants(row.ref.id).includes(destination.entryId))
      )
        return "inside-itself";
    }
    // Copy adds beside what is there, so only a folder inside itself refuses.
    if (action === "copy") return null;
    return placed.every(({ at }) => at?.entry.parentId === destination.entryId)
      ? "already-there"
      : null;
  };

  /**
   * Every other place among its own siblings, in the parent's complete order
   * (not what a search shows): the top, after each sibling, the bottom. The
   * place it already holds is not offered.
   */
  function positionChoices(folderName: string) {
    const here = placed[0]?.at;
    if (several || !here) return [];
    const siblings = here.tree.children(here.entry.parentId ?? here.tree.root.entryId);
    const at = siblings.findIndex((sibling) => sibling.entryId === entry.id);
    if (at < 0) return [];
    const others = siblings.filter((sibling) => sibling.entryId !== entry.id);
    const choices: {
      key: string;
      icon: LucideIcon;
      label: string;
      index: number;
    }[] = [];
    if (at > 0)
      choices.push({
        key: "start",
        icon: ArrowUpToLine,
        label: t`Move to the top of ${folderName}`,
        index: 0,
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
              index: others.length,
            }
          : {
              key: `after:${other.entryId}`,
              icon: CornerDownRight,
              label: t`Move after ${sibling}`,
              index: index + 1,
            },
      );
    });
    return choices;
  }

  function move(trail: readonly DrillNode[], index?: number) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!destination?.writable || pending || (index === undefined && refusalAt(destination)))
      return;
    setError(null);
    const actions = destination.scheme === "user" ? accountActions : projectActions;
    const moving = placed.filter(
      ({ at: here }) => here && !(several && here.entry.parentId === destination.entryId),
    );
    actions.moveAll(
      moving.map(({ row }) => ({
        node: row.ref.id,
        parentId: destination.entryId,
        ...(index === undefined ? {} : { index }),
      })),
    );
    selectRows(
      selection,
      moving.map(({ row }) => row.ref),
    );
    revealFolder(destination.entryId);
    movedSeveral.current = several;
    onOpenChange(false);
    // The row this picker opened from may have moved and unmounted it, so this can't wait for close.
    if (several) selection?.focus();
  }

  /** Copies the row into the folder at the end of `trail`. */
  async function copy(trail: readonly DrillNode[]) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!folder || !destination?.writable || pending || refusalAt(destination)) return;
    setPending(true);
    setError(null);
    try {
      const plan = copyPlan(destination, folder.name);
      if (!plan) throw new Error(unavailable);
      const { rows, settled } = await copyRows(
        projectId,
        plan,
        (documentId, view) => registry?.openStateVector(documentId as DocumentId, view) ?? null,
      );
      const notice = copySettledNotice(settled, plan);
      if (notice) {
        setError(notice);
        return;
      }
      selectRows(selection, rows);
      revealFolder(destination.entryId);
      onOpenChange(false);
    } catch {
      setError(unavailable);
    } finally {
      setPending(false);
    }
  }

  const copyPlan = (
    destination: NonNullable<ReturnType<typeof source.folderFor>>,
    destinationName: string,
  ): ReadyCopy | null => {
    const copies = placed.flatMap(({ row, at }) =>
      at
        ? [
            {
              entry: row.ref,
              name: row.name,
              view: row.view,
              place: { scheme: at.scheme, owner: at.owner, path: at.entry.path },
            },
          ]
        : [],
    );
    if (copies.length !== placed.length) return null;
    return {
      kind: "ready",
      destinationName,
      scheme: destination.scheme,
      area: {
        scheme: destination.scheme,
        owner: destination.owner,
        tree: destination.tree,
        writable: destination.writable,
        ...(shell?.showing === "draft"
          ? {
              view: {
                kind: "draft" as const,
                owner: shell.ownerKey as DraftOwnerKey,
              },
            }
          : {}),
      },
      into: destination.entryId,
      copies,
    };
  };

  // The top level offers only areas that take changes (an ended Work's Scratch reads, and copies
  // out, but takes nothing), and Move… only the areas of the row's own list.
  const inAccount = placed[0]?.at?.scheme === "user";
  const tree = {
    ...source.tree,
    children: (folderId: string | null) =>
      folderId === null
        ? source.tree
            .children(null)
            .filter(
              (node) =>
                source.areaWritable(node.id) &&
                (action === "copy" || (source.folderFor(node.id)?.scheme === "user") === inAccount),
            )
        : source.tree.children(folderId),
  };

  return (
    <DrillInMenu
      // The trees may resolve the initial destination after this open picker mounts.
      key={openAt.map((node) => node.id).join("/")}
      tree={tree}
      hereIds={openAt.map((node) => node.id)}
      openAt={openAt}
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        if (movedSeveral.current && selection) return selection.focus();
        rowRef.current?.querySelector<HTMLElement>("[data-list-item]")?.focus();
      }}
      status={error}
      foldersOnly
      isDisabled={(node) => {
        const folder = source.folderFor(node.id);
        return !folder || refusalAt(folder) === "inside-itself";
      }}
      onPick={() => undefined}
      actions={(trail) => {
        const folder = trail.at(-1);
        if (!folder) return [];
        const destination = source.folderFor(folder.id);
        const blocked = destination ? refusalAt(destination) : "inside-itself";
        if (!destination?.writable || blocked === "inside-itself") return [];
        if (action === "copy") {
          return [
            {
              key: "copy",
              icon: Copy,
              label: t`Copy here`,
              disabled: pending,
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
              label: t`Change position`,
              disabled: pending,
              onSelect: () => undefined,
              choices: positions.map((choice) => ({
                ...choice,
                disabled: pending,
                onSelect: () => {
                  move(trail, choice.index);
                },
              })),
            },
          ];
        return [
          {
            key: "move",
            icon: FolderInput,
            label: already ? t`Already in ${folder.name}` : t`Move here`,
            disabled: already || pending,
            onSelect: () => move(trail),
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
