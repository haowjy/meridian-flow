/** One namespace interaction model for tree, phone and Work Files rows. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogNode } from "@/client/query/context-catalog-projection";
import type { OpenDocumentOwner } from "@/client/stores";
import { focusWhenFree } from "@/lib/focus-follow";
import { type EntryAction, useEntryMenu } from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import type { ContextEntrySibling } from "./context-entry-name";
import { parentContextEntryPath } from "./context-entry-name";
import { type DragEntry, dragEntry } from "./entry-drag/entry";
import { useRenameOperation } from "./LinkUpdateNote";
import type { UseRenameEntryFormOptions } from "./use-rename-entry-form";
import { useEntryRenameRepair } from "./use-repair-on-fresh-failure";

export type EntryCapabilities = readonly Exclude<
  EntryAction,
  "new-file" | "new-folder" | "import-folder" | "import-files"
>[];
export type EntryCreation = (kind: ContextCreateKind, parentPath: string) => void;

/** Starts an import into a folder; `folders` is false where the browser cannot pick one. */
export type ImportHere = { start: (kind: "folder" | "files") => void; folders: boolean };

export function entryActions(
  capabilities: EntryCapabilities,
  create?: EntryCreation,
  importHere?: ImportHere,
): readonly EntryAction[] {
  return create
    ? [
        "new-file",
        "new-folder",
        ...(importHere?.folders ? (["import-folder"] as const) : []),
        ...(importHere ? (["import-files"] as const) : []),
        ...capabilities,
      ]
    : capabilities;
}

export function useEntryInteraction({
  projectId,
  node,
  owner,
  scheme,
  capabilities,
  onRequestDelete,
  create,
  siblings,
  arriving,
  onArrived,
  importHere,
}: {
  projectId: string;
  node: CatalogNode;
  owner: ContextOwner;
  scheme: ProjectContextTreeScheme;
  capabilities: EntryCapabilities;
  /** Deletes entries in one gesture: this row, or the selection its menu acted on. */
  onRequestDelete: (entries: readonly DragEntry[]) => void;
  create?: EntryCreation;
  siblings: readonly ContextEntrySibling[];
  /** A row creation just made: it takes focus once it is on screen. */
  arriving?: boolean;
  onArrived?: () => void;
  /** Opens the OS picker for an import into this folder; only folders offer it. */
  importHere?: ImportHere;
  /** Sends a file whose import failed again; a failed file's menu leads with it. */
}) {
  const [renaming, setRenaming] = useState(false);
  const control = useRef<HTMLElement | null>(null);
  // Set when the name field closes, so the row that replaces it takes focus back.
  const refocus = useRef(false);
  const controlRef = useCallback((element: HTMLElement | null) => {
    control.current = element;
    if (!element || !refocus.current) return;
    refocus.current = false;
    focusWhenFree(element);
  }, []);
  useEffect(() => {
    if (!arriving) return;
    onArrived?.();
    if (control.current) focusWhenFree(control.current);
  }, [arriving, onArrived]);
  // The picker is one component for both; which action opened it decides what a pick does.
  const [picking, setPicking] = useState<"move" | "copy" | null>(null);
  // Set while the picker moves a selection rather than this row alone.
  const [pickedSelection, setPickedSelection] = useState<readonly DragEntry[] | null>(null);
  const entry = useMemo(() => dragEntry(node), [node]);
  const id = node.kind === "file" ? node.documentId : node.entryId;
  const kind: "file" | "folder" = node.kind === "file" ? "file" : "folder";
  const { operationId, remember } = useRenameOperation(projectId, { kind, id });
  const parsed = parseContextUri(node.uri);
  let resolvedOwner: OpenDocumentOwner = { workId: owner.workId ?? undefined };
  if (owner.rootThreadId) {
    const rootThreadRef =
      owner.rootThreadRef ??
      (parsed.ok && parsed.value.authority.kind === "lineage"
        ? parsed.value.authority.rootThreadRef
        : undefined);
    if (!rootThreadRef) throw new Error("Scratch lineage entry requires its URI authority");
    resolvedOwner = { rootThreadId: owner.rootThreadId, rootThreadRef };
  }
  const actions: readonly EntryAction[] =
    node.kind === "dir" && node.navigationOnly
      ? []
      : [...entryActions(capabilities, create, node.kind === "dir" ? importHere : undefined)];
  useEntryRenameRepair(node, () => setRenaming(true), actions.includes("rename"));
  const onAction = (action: EntryAction) => {
    if (!actions.includes(action)) return;
    if (action === "rename") setRenaming(true);
    else if (action === "move" || action === "copy") setPicking(action);
    else if (action === "import-folder") importHere?.start("folder");
    else if (action === "import-files") importHere?.start("files");
    else if (action === "new-file" || action === "new-folder")
      create?.(
        action === "new-file" ? "file" : "folder",
        node.kind === "dir" ? node.path : parentContextEntryPath(node.path),
      );
    else if (action === "delete") onRequestDelete([entry]);
  };
  const menu = useEntryMenu(entry, actions, (action, selection) => {
    if (!selection) {
      setPickedSelection(null);
      onAction(action);
    } else if (action === "move") {
      setPickedSelection(selection);
      setPicking("move");
    } else if (action === "delete") onRequestDelete(selection);
  });
  const rename: UseRenameEntryFormOptions = {
    projectId,
    owner: resolvedOwner,
    scheme,
    entryId: id,
    currentName: node.name,
    ...(node.kind === "file" ? { row: node } : {}),
    repairName: node.namespaceRepairMove ? undefined : node.namespaceRepairName,
    siblings,
    kind,
    onRenamed: remember,
    onDone: () => {
      refocus.current = true;
      setRenaming(false);
    },
  };
  return {
    renaming: renaming && actions.includes("rename"),
    rename,
    /** The row's main control, which takes focus back when its name field closes. */
    controlRef,
    operationId,
    actions,
    onAction,
    entry,
    menu,
    picker: {
      projectId,
      // Closed, it still names the action it would open for.
      action: picking ?? "move",
      from: { scheme, owner: resolvedOwner },
      entry: { id, name: node.name, path: node.path, kind },
      selection: pickedSelection ?? undefined,
      repairMove: node.namespaceRepairMove,
      open: picking !== null && actions.includes(picking),
      onOpenChange: (open: boolean) => {
        if (!open) {
          setPicking(null);
          setPickedSelection(null);
        }
      },
    },
  };
}
