/** One namespace interaction model for tree, phone and Work Files rows. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useState } from "react";
import type { CatalogNode } from "@/client/query/context-catalog-projection";
import type { TabOwner } from "@/client/stores";
import { ContextEntryMenu, type DeleteTarget, type EntryAction } from "./ContextEntryActions";
import type { ContextCreateKind } from "./context-create-kind";
import { parentContextEntryPath } from "./context-entry-name";
import { EntryMovePicker } from "./EntryMovePicker";
import { useRenameOperation } from "./LinkUpdateNote";
import type { UseRenameEntryFormOptions } from "./use-rename-entry-form";
import { useEntryRenameRepair } from "./use-repair-on-fresh-failure";

export type EntryCapabilities = readonly Exclude<EntryAction, "new-file" | "new-folder">[];
export type EntryCreation = (kind: ContextCreateKind, parentPath: string) => void;

export function entryActions(
  capabilities: EntryCapabilities,
  create?: EntryCreation,
): readonly EntryAction[] {
  return create ? ["new-file", "new-folder", ...capabilities] : capabilities;
}

export function useEntryInteraction({
  projectId,
  node,
  owner,
  scheme,
  capabilities,
  onRequestDelete,
  create,
  siblingNames,
  requestRename,
  onRenameDone,
}: {
  projectId: string;
  node: CatalogNode;
  owner: ContextOwner;
  scheme: ProjectContextTreeScheme;
  capabilities: EntryCapabilities;
  onRequestDelete: (target: DeleteTarget) => void;
  create?: EntryCreation;
  siblingNames: readonly string[];
  /** Creation may ask an arriving row to open its naming field. */
  requestRename?: boolean;
  onRenameDone?: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);
  const id = node.kind === "file" ? node.documentId : node.entryId;
  const kind: "file" | "folder" = node.kind === "file" ? "file" : "folder";
  const { operationId, remember } = useRenameOperation(projectId, { kind, id });
  const parsed = parseContextUri(node.uri);
  let resolvedOwner: TabOwner = { workId: owner.workId ?? undefined };
  if (owner.rootThreadId) {
    const rootThreadRef =
      owner.rootThreadRef ??
      (parsed.ok && parsed.value.authority.kind === "lineage"
        ? parsed.value.authority.rootThreadRef
        : undefined);
    if (!rootThreadRef) throw new Error("Scratch lineage entry requires its URI authority");
    resolvedOwner = { rootThreadId: owner.rootThreadId, rootThreadRef };
  }
  const actions = entryActions(capabilities, create);
  useEntryRenameRepair(node, () => setRenaming(true), capabilities.includes("rename"));
  const onAction = (action: EntryAction) => {
    if (!actions.includes(action)) return;
    if (action === "rename") setRenaming(true);
    else if (action === "move") setMoving(true);
    else if (action === "new-file" || action === "new-folder")
      create?.(
        action === "new-file" ? "file" : "folder",
        node.kind === "dir" ? node.path : parentContextEntryPath(node.path),
      );
    else if (action === "delete")
      onRequestDelete(
        node.kind === "file"
          ? { name: node.name, path: node.path, kind: "file", documentId: node.documentId, owner }
          : { name: node.name, path: node.path, kind: "dir", owner },
      );
  };
  const rename: UseRenameEntryFormOptions = {
    projectId,
    owner: resolvedOwner,
    scheme,
    entryId: id,
    path: node.path,
    currentName: node.name,
    repairName: node.namespaceRepairMove ? undefined : node.namespaceRepairName,
    siblingNames,
    kind,
    onRenamed: remember,
    onDone: () => {
      setRenaming(false);
      onRenameDone?.();
    },
  };
  return {
    renaming: (renaming || Boolean(requestRename)) && capabilities.includes("rename"),
    rename,
    operationId,
    actions,
    onAction,
    movePicker: {
      projectId,
      owner: resolvedOwner,
      scheme,
      entry: { id, name: node.name, path: node.path, kind },
      repairMove: node.namespaceRepairMove,
      open: moving && capabilities.includes("move"),
      onOpenChange: setMoving,
      onMoved: remember,
    },
  };
}

export function EntryInteractionShell({
  interaction,
  children,
  contextMenu = true,
}: {
  interaction: ReturnType<typeof useEntryInteraction>;
  children: ReactNode;
  contextMenu?: boolean;
}) {
  return (
    <EntryMovePicker {...interaction.movePicker}>
      {contextMenu ? (
        <ContextEntryMenu allowedActions={interaction.actions} onAction={interaction.onAction}>
          {children}
        </ContextEntryMenu>
      ) : (
        children
      )}
    </EntryMovePicker>
  );
}
