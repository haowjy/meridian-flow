/**
 * The Work Files tab's rows: a folder, a catalog file (renamed in place, or
 * only opened while its Work is read-only), and a file still on its way.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder, FolderOpen } from "lucide-react";
import type { ReactNode } from "react";
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
import type { FileAttempt } from "./use-work-file-intake";

export type WorkFileScheme = "scratch" | "uploads";

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

export function CatalogFileRow({
  projectId,
  workId,
  scheme,
  file,
  siblingNames,
  readOnly,
  renaming,
  onRename,
  onDelete,
}: {
  projectId: string;
  workId: string;
  scheme: WorkFileScheme;
  file: CatalogFile;
  siblingNames: readonly string[];
  readOnly: boolean;
  renaming: boolean;
  onRename: (path: string | null) => void;
  onDelete?: () => void;
}) {
  const openFile = useOpenFileInDock(workId);
  const docked = useDockViewStore(
    (state) => state.workFile?.workId === workId && state.workFile.tab.path === file.path,
  );
  const folder = file.path.includes("/") ? file.path.replace(/\/[^/]+$/, "") : "";
  if (renaming && !readOnly)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={fileKindIcon(file)} />
        <InlineRename
          projectId={projectId}
          workId={workId}
          scheme={scheme}
          file={file}
          siblingNames={siblingNames}
          onDone={() => onRename(null)}
        />
      </div>
    );
  const onAction = (action: EntryAction) => {
    if (action === "rename") onRename(file.path);
    if (action === "delete") onDelete?.();
  };
  const open = () => openFile(viewerTabForCatalogFile(file, scheme, workId));
  const row = (
    <div
      className={cn("group relative flex min-w-0 items-center", docked && "rounded-md bg-muted")}
    >
      <button
        type="button"
        className={cn(workFileRowClass, !readOnly && "pr-10")}
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
      {readOnly ? null : (
        <div className="absolute right-1">
          <EntryKebabButton
            allowCreate={false}
            allowDelete={Boolean(onDelete)}
            onAction={onAction}
            align="end"
          />
        </div>
      )}
    </div>
  );
  // Rename and Delete are the whole menu, so a read-only row has none.
  if (readOnly) return row;
  return (
    <ContextEntryMenu allowCreate={false} allowDelete={Boolean(onDelete)} onAction={onAction}>
      {row}
    </ContextEntryMenu>
  );
}

/** A file on its way into the catalog: pending, or refused with Retry and Dismiss. */
export function FileAttemptRow({
  attempt,
  pendingLabel,
  failureLabel,
  onRetry,
  onDismiss,
}: {
  attempt: FileAttempt;
  pendingLabel: ReactNode;
  failureLabel: ReactNode;
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
          {pendingLabel}
        </span>
      ) : (
        <>
          <span role="alert" className="shrink-0 text-xs text-destructive">
            {failureLabel}
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
  scheme,
  file,
  siblingNames,
  onDone,
}: {
  projectId: string;
  workId: string;
  scheme: WorkFileScheme;
  file: CatalogFile;
  siblingNames: readonly string[];
  onDone: () => void;
}) {
  const form = useRenameEntryForm({
    projectId,
    entryId: file.entryId,
    workId,
    scheme,
    path: file.path,
    currentName: file.name,
    siblingNames,
    kind: "file",
    onDone,
  });
  return <EntryNameField form={form} label={t`File name`} />;
}
