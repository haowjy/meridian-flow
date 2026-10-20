import type { ContextEntrySibling } from "../context/context-entry-name";
/**
 * The Work Files tab's Scratch rows: folder disclosure and file navigation
 * around the shared entry interaction model, plus a new note still on its way.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder, FolderOpen, type LucideIcon } from "lucide-react";
import type { CatalogDirectory, CatalogFile } from "@/client/query/context-catalog-projection";
import { cn } from "@/lib/utils";
import { type DeleteTarget, EntryKebabButton } from "../context/ContextEntryActions";
import { fileKindIcon } from "../context/context-file-icon";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { EntryNameField } from "../context/EntryNameField";
import { LinkUpdateNote } from "../context/LinkUpdateNote";
import { NamespaceFailureMark } from "../context/NamespaceFailureMark";
import {
  type EntryCapabilities,
  EntryInteractionShell,
  useEntryInteraction,
} from "../context/use-entry-interaction";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { useDockDocument } from "../dock/dock-document-store";
import { useOpenDocumentInDock } from "../dock/use-open-document-in-dock";
import { RowIcon } from "../RuledList";
import { useProjectScreen } from "../routing/ProjectNavigationContext";
import type { NoteAttempt } from "./use-work-note-intake";

export const workFileRowClass =
  "focus-ring flex min-h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors motion-reduce:transition-none hover:bg-dropdown-hover";

type ScratchRowManagement = {
  projectId: string;
  workId: string;
  siblings: readonly ContextEntrySibling[];
  capabilities: EntryCapabilities;
  onRequestDelete: (target: DeleteTarget) => void;
};

export function FolderRow({
  folder,
  open,
  onToggle,
  icon,
  onOpenChat,
  ...management
}: ScratchRowManagement & {
  folder: CatalogDirectory;
  open: boolean;
  onToggle: () => void;
  /** A chat's notes folder wears the chat mark, not the generic folder. */
  icon?: LucideIcon;
  onOpenChat?: () => void;
}) {
  const interaction = useEntryInteraction({
    ...management,
    node: folder,
    owner: { workId: management.workId },
    scheme: "scratch",
    onOpenChat,
  });
  const Icon = icon ?? (open ? FolderOpen : Folder);
  if (interaction.renaming)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={Icon} />
        <InlineRename options={interaction.rename} />
      </div>
    );
  return (
    <EntryInteractionShell interaction={interaction}>
      <div className="group relative flex min-w-0 items-center">
        <button
          type="button"
          className={cn(workFileRowClass, interaction.actions.length > 0 && "pr-10")}
          aria-expanded={open}
          onClick={onToggle}
        >
          <RowIcon icon={Icon} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{folder.name}</span>
            <LinkUpdateNote
              projectId={management.projectId}
              subject={{ kind: "folder", id: folder.entryId }}
              operationId={interaction.operationId}
              layout="stacked"
            />
            {folder.namespaceFailure ? (
              <NamespaceFailureMark
                failure={folder.namespaceFailure}
                move={Boolean(folder.namespaceRepairMove)}
                folder
                labelled
              />
            ) : null}
          </span>
        </button>
        <div className="absolute right-1">
          <EntryKebabButton
            allowedActions={interaction.actions}
            onAction={interaction.onAction}
            align="end"
          />
        </div>
      </div>
    </EntryInteractionShell>
  );
}

export function ScratchFileRow({
  projectId,
  workId,
  file,
  siblings,
  capabilities,
  onRequestDelete,
  requestRename,
  onRenameDone,
}: ScratchRowManagement & {
  file: CatalogFile;
  requestRename?: boolean;
  onRenameDone?: () => void;
}) {
  const openFile = useOpenDocumentInDock();
  const screen = useProjectScreen();
  const docked = useDockDocument(screen, projectId)?.tab.documentId === file.documentId;
  const folder = file.parentLabels?.join("/") ?? "";
  const interaction = useEntryInteraction({
    projectId,
    node: file,
    owner: { workId },
    scheme: "scratch",
    siblings,
    capabilities,
    onRequestDelete,
    requestRename,
    onRenameDone,
  });
  if (interaction.renaming)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={fileKindIcon(file)} />
        <InlineRename options={interaction.rename} />
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
        className={cn(workFileRowClass, interaction.actions.length > 0 && "pr-10")}
        aria-current={docked || undefined}
        onClick={open}
      >
        <RowIcon icon={fileKindIcon(file)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{file.name}</span>
          <LinkUpdateNote
            projectId={projectId}
            subject={{ kind: "file", id: file.documentId }}
            operationId={interaction.operationId}
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
      {interaction.actions.length > 0 ? (
        <div className="absolute right-1">
          <EntryKebabButton
            allowedActions={interaction.actions}
            onAction={interaction.onAction}
            align="end"
          />
        </div>
      ) : null}
    </div>
  );
  return <EntryInteractionShell interaction={interaction}>{row}</EntryInteractionShell>;
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

function InlineRename({ options }: { options: Parameters<typeof useRenameEntryForm>[0] }) {
  const form = useRenameEntryForm(options);
  return (
    <EntryNameField form={form} label={options.kind === "folder" ? t`Rename` : t`File name`} />
  );
}
