/**
 * The Work Files tab's Scratch rows: a folder, a file (renamed in place, or
 * only opened when its Work is not editable), and a new note still on its way.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder, FolderOpen } from "lucide-react";
import type { CatalogDirectory, CatalogFile } from "@/client/query/context-catalog-projection";
import { viewerTabForCatalogFile } from "@/client/stores";
import { cn } from "@/lib/utils";
import {
  ContextEntryMenu,
  type EntryAction,
  EntryKebabButton,
} from "../context/ContextEntryActions";
import { fileKindIcon } from "../context/context-file-icon";
import { EntryNameField } from "../context/EntryNameField";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { useDockViewStore } from "../dock/dock-view-store";
import { useOpenFileInDock } from "../dock/use-open-file-in-dock";
import { RowIcon } from "../RuledList";
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

/** Rename and Delete, offered only while the file's Work is editable. */
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
  const openFile = useOpenFileInDock(workId);
  const docked = useDockViewStore(
    (state) => state.workFile?.workId === workId && state.workFile.tab.path === file.path,
  );
  const folder = file.path.includes("/") ? file.path.replace(/\/[^/]+$/, "") : "";
  if (edit?.renaming)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={fileKindIcon(file)} />
        <InlineRename
          projectId={projectId}
          workId={workId}
          file={file}
          siblingNames={siblingNames}
          onDone={() => edit.onRename(null)}
        />
      </div>
    );
  const open = () => openFile(viewerTabForCatalogFile(file, "scratch", workId));
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
          {folder ? (
            <span className="block truncate text-xs text-muted-foreground">{folder}</span>
          ) : null}
        </span>
      </button>
      {edit ? (
        <div className="absolute right-1">
          <EntryKebabButton
            allowCreate={false}
            allowDelete
            onAction={(action) => onEditAction(edit, file, action)}
            align="end"
          />
        </div>
      ) : null}
    </div>
  );
  // Rename and Delete are the whole menu, so a row that only opens has none.
  if (!edit) return row;
  return (
    <ContextEntryMenu
      allowCreate={false}
      allowDelete
      onAction={(action) => onEditAction(edit, file, action)}
    >
      {row}
    </ContextEntryMenu>
  );
}

function onEditAction(edit: ScratchFileEdit, file: CatalogFile, action: EntryAction) {
  if (action === "rename") edit.onRename(file.path);
  if (action === "delete") edit.onDelete();
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
  onDone,
}: {
  projectId: string;
  workId: string;
  file: CatalogFile;
  siblingNames: readonly string[];
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    workId,
    scheme: "scratch",
    path: file.path,
    currentName: file.name,
    siblingNames,
    kind: "file",
    onDone,
  });
  return <EntryNameField form={form} label={t`File name`} />;
}
