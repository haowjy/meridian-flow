import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpenDocumentOwner } from "@/client/stores";
import type { TreeEntry } from "@/core/project-tree/tree-view";
import { focusWhenFree } from "@/lib/focus-follow";
import { useShellTreeVersion } from "../tree-version";
import { type EntryAction, useEntryMenu } from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { type DragEntry, dragEntry } from "./entry-drag/entry";
import type { UseRenameEntryFormOptions } from "./use-rename-entry-form";

export type EntryCapabilities = readonly Exclude<
  EntryAction,
  "new-file" | "new-folder" | "import-folder" | "import-files"
>[];
export type EntryCreation = (kind: ContextCreateKind, parentPath: string) => void;

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
  arriving,
  onArrived,
  importHere,
}: {
  projectId: string;
  node: TreeEntry;
  owner: ContextOwner;
  scheme: ProjectContextTreeScheme;
  capabilities: EntryCapabilities;
  onRequestDelete: (entries: readonly DragEntry[]) => void;
  create?: EntryCreation;
  arriving?: boolean;
  onArrived?: () => void;
  importHere?: ImportHere;
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
  const shell = useShellTreeVersion();
  const entry = useMemo(
    () => ({
      ...dragEntry(node),
      ...(shell?.showing === "draft"
        ? {
            view: {
              kind: "draft" as const,
              draft: shell.draftId,
            },
          }
        : {}),
    }),
    [node, shell],
  );
  const id = node.entryId;
  const kind: "file" | "folder" = node.kind === "file" ? "file" : "folder";
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
  const actions: readonly EntryAction[] = entryActions(
    capabilities,
    create,
    node.kind === "dir" ? importHere : undefined,
  );
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
  const menu = useEntryMenu(
    entry,
    actions,
    (action, selection) => {
      if (!selection) {
        setPickedSelection(null);
        onAction(action);
      } else if (action === "move" || action === "copy") {
        setPickedSelection(selection);
        setPicking(action);
      } else if (action === "delete") onRequestDelete(selection);
    },
    scheme === "user" ? "account" : "project",
  );
  const rename: UseRenameEntryFormOptions = {
    projectId,
    entryId: id,
    currentName: node.name,
    ...(node.kind === "file" ? { row: node } : {}),
    kind,
    onDone: () => {
      refocus.current = true;
      setRenaming(false);
    },
  };
  return {
    renaming: renaming && actions.includes("rename"),
    rename,
    controlRef,
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
