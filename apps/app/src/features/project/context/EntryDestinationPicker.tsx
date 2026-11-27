import { t } from "@lingui/core/macro";
import type {
  ContextSiblingPosition,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
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
import type { OpenDocumentOwner } from "@/client/stores";
import { DrillInMenu, type DrillNode } from "@/components/app/DrillInMenu";
import { Button } from "@/components/ui/button";
import { useShellTreeVersion } from "../tree-version";
import { useOptionalLiveDocumentSessionRegistry } from "./account-feature-context";
import { schemeLabel } from "./context-schemes";
import { type DragEntry, type EntryRef, LIVE_VIEW } from "./entry-drag/entry";
import { useEntryActions } from "./entry-drag/entry-actions";
import { runCopy, runMove } from "./entry-drag/entry-failure";
import type { ReadyCopy, ReadyMove } from "./entry-drag/move-plan";
import { useOptionalEntrySelection } from "./entry-drag/selection";
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
  from?: { scheme: ProjectContextTreeScheme; owner: OpenDocumentOwner };
  entry: PickedEntry;
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
  const actions = useEntryActions(projectId);
  const selection = useOptionalEntrySelection();
  const registry = useOptionalLiveDocumentSessionRegistry();
  const [error, setError] = useState<string | null>(null);
  const placedRows = useRef(false);
  const scheme = from?.scheme;
  const owner = from?.owner;
  const own = useMemo(
    () => (scheme && owner ? { scheme, owner, heading: schemeLabel(scheme) } : null),
    [scheme, owner],
  );
  const scopeScratch = useScopeScratchSource(projectId);
  const scratch = useMemo(
    () => (scheme === "scratch" && owner ? { owner, heading: schemeLabel(scheme) } : scopeScratch),
    [scheme, owner, scopeScratch],
  );
  const source = useProjectMenuSource({ projectId, title: "", own, scratch });
  const openAt = own && source.own.writable ? source.own.openAt(entry.path) : [];
  const unavailable = t`This location is unavailable`;

  const several = picked !== undefined && picked.length > 1;
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
                    draft: shell.draftId,
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
    if (action === "copy") return null;
    return placed.every(({ at }) => at?.entry.parentId === destination.entryId)
      ? "already-there"
      : null;
  };

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

  function move(trail: readonly DrillNode[], position?: ContextSiblingPosition) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!folder || !destination?.writable || (!position && refusalAt(destination))) return;
    const area = {
      scheme: destination.scheme,
      owner: destination.owner,
      tree: destination.tree,
      writable: destination.writable,
    };
    const moves = placed.flatMap(({ row, at: here }) => {
      if (!here) return [];
      const from = here.entry.parentId ?? here.tree.root.entryId;
      if (several && from === destination.entryId) return [];
      return [{ entry: row.ref, from }];
    });
    const plan: ReadyMove = {
      kind: "ready",
      destinationName: folder.name,
      to: { parentId: destination.entryId, ...(position ? { position } : {}) },
      area,
      moves,
    };
    runMove({ actions, projectId }, plan, selection);
    placedRows.current = true;
    onOpenChange(false);
    if (several) selection?.focus();
  }

  function copy(trail: readonly DrillNode[]) {
    const folder = trail.at(-1);
    const destination = folder && source.folderFor(folder.id);
    if (!folder || !destination?.writable || refusalAt(destination)) return;
    const plan = copyPlan(destination, folder.name);
    if (!plan) return setError(unavailable);
    void runCopy(
      {
        actions,
        projectId,
        roomVersionOf: (documentId) => registry?.openRoomVersion(documentId as DocumentId) ?? null,
      },
      plan,
      selection,
    );
    placedRows.current = true;
    onOpenChange(false);
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
                draft: shell.draftId,
              },
            }
          : {}),
      },
      into: destination.entryId,
      copies,
    };
  };

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
        if (placedRows.current && selection) return selection.focus();
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
              onSelect: () => copy(trail),
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
              onSelect: () => undefined,
              choices: positions.map((choice) => ({
                ...choice,
                onSelect: () => {
                  move(trail, choice.position);
                },
              })),
            },
          ];
        return [
          {
            key: "move",
            icon: FolderInput,
            label: already ? t`Already in ${folder.name}` : t`Move here`,
            disabled: already,
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
