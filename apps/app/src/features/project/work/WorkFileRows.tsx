/**
 * The Work Files tab's Scratch rows: a folder, a file (renamed in place, or
 * only opened when its Work is not editable), and a new note still on its way.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder, FolderOpen } from "lucide-react";
import { useState } from "react";
import type { CatalogDirectory, CatalogFile } from "@/client/query/context-catalog-projection";
import { cn } from "@/lib/utils";
import {
  ContextEntryMenu,
  type EntryAction,
  EntryKebabButton,
} from "../context/ContextEntryActions";
import { fileKindIcon } from "../context/context-file-icon";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { EntryMovePicker } from "../context/EntryMovePicker";
import { EntryNameField } from "../context/EntryNameField";
import {
  LinkUpdateNote,
  rememberRenameOperation,
  useRenameOperation,
} from "../context/LinkUpdateNote";
import { NamespaceFailureMark } from "../context/NamespaceFailureMark";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { useEntryRenameRepair } from "../context/use-repair-on-fresh-failure";
import { useDockDocument } from "../dock/dock-view-store";
import { useOpenDocumentInDock } from "../dock/use-open-document-in-dock";
import { RowIcon } from "../RuledList";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import type { NoteAttempt } from "./use-work-note-intake";

export const workFileRowClass =
  "focus-ring flex min-h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors motion-reduce:transition-none hover:bg-dropdown-hover";

export function FolderRow({
  folder,
  open,
  onToggle,
}: {
  folder: CatalogDirectory;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={workFileRowClass} aria-expanded={open} onClick={onToggle}>
      <RowIcon icon={open ? FolderOpen : Folder} />
      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
    </button>
  );
}

/** Rename, Move and Delete, offered only while the file's Work is editable. */
export type ScratchFileEdit = {
  renaming: boolean;
  onRename: (path: string | null) => void;
  onDelete: () => void;
};

export function ScratchFileRow({
  projectId,
  workId,
  file,
  siblingNames,
  edit,
}: {
  projectId: string;
  workId: string;
  file: CatalogFile;
  siblingNames: readonly string[];
  /** Absent: the row only opens, with no menu, kebab or rename. */
  edit?: ScratchFileEdit;
}) {
  const openFile = useOpenDocumentInDock();
  const screen = useProjectScreen();
  const docked = useDockDocument(screen, projectId)?.tab.documentId === file.documentId;
  const folder = file.path.includes("/") ? file.path.replace(/\/[^/]+$/, "") : "";
  const [moving, setMoving] = useState(false);
  // Renames and moves from any list share one note per document, so a moved row still shows it.
  const noteOperationId = useRenameOperation(file.documentId);
  const setNoteOperationId = (operationId: string) =>
    rememberRenameOperation(file.documentId, operationId);
  // Like the tree, a refused rename offers its name field once, as the failure arrives.
  useEntryRenameRepair(file, () => edit?.onRename(file.path), Boolean(edit));
  const actions: readonly EntryAction[] = edit ? ["rename", "move", "delete"] : [];
  const handleAction = (action: EntryAction) => {
    if (!edit) return;
    if (action === "rename") edit.onRename(file.path);
    if (action === "move") setMoving(true);
    if (action === "delete") edit.onDelete();
  };
  if (edit?.renaming)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={fileKindIcon(file)} />
        <InlineRename
          projectId={projectId}
          workId={workId}
          file={file}
          siblingNames={siblingNames}
          onRenamed={setNoteOperationId}
          onDone={() => edit.onRename(null)}
        />
      </div>
    );
  const open = () => {
    const tab = serverTabFromFile("scratch", file, { workId });
    if (tab) openFile(tab);
  };
  const row = (
    <div
      className={cn("group relative flex min-w-0 items-center", docked && "rounded-md bg-muted")}
    >
      <button
        type="button"
        className={cn(workFileRowClass, edit && "pr-10")}
        aria-current={docked || undefined}
        onClick={open}
      >
        <RowIcon icon={fileKindIcon(file)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{file.name}</span>
          <LinkUpdateNote
            projectId={projectId}
            subject={{ kind: "file", id: file.documentId }}
            operationId={noteOperationId}
            layout="stacked"
          />
          {folder ? (
            <span className="block truncate text-xs text-muted-foreground">{folder}</span>
          ) : null}
          {file.namespaceFailure ? (
            <NamespaceFailureMark
              failure={file.namespaceFailure}
              move={Boolean(file.namespaceRepairMove)}
              labelled
            />
          ) : null}
        </span>
      </button>
      {edit ? (
        <div className="absolute right-1">
          <EntryKebabButton allowedActions={actions} onAction={handleAction} align="end" />
        </div>
      ) : null}
    </div>
  );
  // An archived Work row only opens, with no mutation actions.
  if (!edit) return row;
  return (
    <EntryMovePicker
      projectId={projectId}
      scheme="scratch"
      owner={{ workId }}
      entry={{ id: file.documentId, name: file.name, path: file.path, kind: "file" }}
      repairMove={file.namespaceRepairMove}
      open={moving}
      onOpenChange={setMoving}
    >
      <ContextEntryMenu allowedActions={actions} onAction={handleAction}>
        {row}
      </ContextEntryMenu>
    </EntryMovePicker>
  );
}

/**
 * A new note on its way into Scratch: pending, or refused with Dismiss and,
 * while its Work is still editable, Retry.
 */
export function NoteAttemptRow({
  attempt,
  onRetry,
  onDismiss,
}: {
  attempt: NoteAttempt;
  onRetry?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 px-2 py-1.5 text-sm">
      <RowIcon icon={fileKindIcon(attempt.name)} />
      <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">
        {attempt.name}
      </span>
      {attempt.state === "pending" ? (
        <span role="status" className="shrink-0 text-xs text-ink-subtle">
          <Trans>Creating…</Trans>
        </span>
      ) : (
        <>
          <span role="alert" className="shrink-0 text-xs text-destructive">
            <Trans>Couldn’t create note</Trans>
          </span>
          {onRetry ? (
            <button type="button" className="text-button shrink-0 text-xs" onClick={onRetry}>
              <Trans>Retry</Trans>
            </button>
          ) : null}
          <button type="button" className="text-button shrink-0 text-xs" onClick={onDismiss}>
            <Trans>Dismiss</Trans>
          </button>
        </>
      )}
    </div>
  );
}

function InlineRename({
  projectId,
  workId,
  file,
  siblingNames,
  onRenamed,
  onDone,
}: {
  projectId: string;
  workId: string;
  file: CatalogFile;
  siblingNames: readonly string[];
  onRenamed: (operationId: string) => void;
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    owner: { workId },
    scheme: "scratch",
    path: file.path,
    currentName: file.name,
    repairName: file.namespaceRepairMove ? undefined : file.namespaceRepairName,
    siblingNames,
    kind: "file",
    onRenamed,
    onDone,
  });
  return <EntryNameField form={form} label={t`File name`} />;
}
