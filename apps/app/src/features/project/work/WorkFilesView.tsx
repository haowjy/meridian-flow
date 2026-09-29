/**
 * Work Files tab: drafts to review, scratch notes and uploads as one grouped
 * list in the same row grammar as the Chats tab and the Editor's recents.
 * `useWorkFiles` owns the tab's state so the page toolbar can host its actions.
 */
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { FilePlus, Folder, FolderOpen, type LucideIcon, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { uploadIntakePort } from "@/client/api/upload-intake-api";
import type { CatalogDirectory, CatalogFile } from "@/client/query/context-catalog-projection";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { activeWorkDraftGroups, useWorkDrafts } from "@/client/query/useWorkDrafts";
import type { AddressableWork } from "@/client/query/useWorks";
import { viewerTabForCatalogFile } from "@/client/stores";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ContextEntryMenu,
  DeleteConfirmationDialog,
  type EntryAction,
  EntryKebabButton,
  useDeleteConfirmation,
} from "../context/ContextEntryActions";
import { fileKindIcon } from "../context/context-file-icon";
import { EntryNameField } from "../context/EntryNameField";
import { useRenameEntryForm } from "../context/use-rename-entry-form";
import { useDockViewStore } from "../dock/dock-view-store";
import { useOpenFileInDock } from "../dock/use-open-file-in-dock";
import { usePostApplyDraftGroupProjections } from "../draft-apply-recovery/DraftApplyRecoveryProvider";
import type { ProjectRouteCommands } from "../routing/project-route";
import { uniqueScratchNoteName } from "./work-file-names";
import {
  catalogSiblingNames,
  filterWorkFileGroups,
  type WorkFileSearch,
  workFileSearch,
} from "./work-files-model";

type Scheme = "scratch" | "uploads";
type UploadAttempt = { key: string; name: string; state: "uploading" | "failed" };
type ScratchNoteAttempt = { key: string; name: string; state: "creating" | "failed" };

export function useWorkFiles(projectId: string, work: AddressableWork) {
  const scratch = useContextCatalogView(projectId, "scratch", { workId: work.id });
  const uploads = useContextCatalogView(projectId, "uploads", { workId: work.id });
  const create = useCreateContextEntry(projectId);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<UploadAttempt[]>([]);
  const [scratchNoteAttempt, setScratchNoteAttempt] = useState<ScratchNoteAttempt | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const submitFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const key = crypto.randomUUID();
        setAttempts((items) => [...items, { key, name: file.name, state: "uploading" }]);
        try {
          await uploadIntakePort.intake({
            file,
            intakeId: key,
            scope: { kind: "work", projectId, workId: work.id },
          });
          setAttempts((items) => items.filter((item) => item.key !== key));
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.contextCatalogView(projectId, "uploads", work.id),
          });
        } catch {
          setAttempts((items) =>
            items.map((item) => (item.key === key ? { ...item, state: "failed" } : item)),
          );
        }
      }
    },
    [projectId, queryClient, work.id],
  );

  const createScratch = useCallback(
    async (retry?: ScratchNoteAttempt) => {
      const siblingNames = [
        ...(scratch.catalog?.children(scratch.catalog.root.entryId).map((entry) => entry.name) ??
          []),
        ...(scratchNoteAttempt ? [scratchNoteAttempt.name] : []),
      ];
      const name =
        retry?.name ??
        uniqueScratchNoteName(
          `Scratch note ${new Date().toLocaleDateString().replaceAll("/", "-")}.md`,
          siblingNames,
        );
      const attempt = { key: retry?.key ?? crypto.randomUUID(), name, state: "creating" as const };
      setScratchNoteAttempt(attempt);
      try {
        await create.mutateAsync({
          scheme: "scratch",
          type: "file",
          path: name,
          content: "",
          workId: work.id,
        });
        setRenaming(name);
        setScratchNoteAttempt(null);
      } catch {
        setScratchNoteAttempt({ ...attempt, state: "failed" });
      }
    },
    [create, scratch.catalog, scratchNoteAttempt, work.id],
  );
  const retryScratchNote = useCallback(() => {
    if (scratchNoteAttempt) void createScratch(scratchNoteAttempt);
  }, [createScratch, scratchNoteAttempt]);
  const dismissScratchNote = useCallback(() => setScratchNoteAttempt(null), []);

  return {
    scratch,
    uploads,
    creating: create.isPending,
    renaming,
    setRenaming,
    attempts,
    scratchNoteAttempt,
    retryScratchNote,
    dismissScratchNote,
    dismissAttempt: (key: string) =>
      setAttempts((items) => items.filter((item) => item.key !== key)),
    picker,
    submitFiles,
    createScratch,
    chooseFiles: () => picker.current?.click(),
  };
}
export type WorkFiles = ReturnType<typeof useWorkFiles>;

/** The Files tab's toolbar actions: a quiet Upload and the jade New note. */
export function WorkFilesActions({ files }: { files: WorkFiles }) {
  return (
    <>
      <input
        ref={files.picker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          if (event.target.files) void files.submitFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <Button
        size="sm"
        variant="outline"
        onClick={files.chooseFiles}
        aria-label={t`Upload files`}
        className="[@media(pointer:coarse)]:min-h-11"
      >
        <Upload aria-hidden />
        <span className="max-sm:hidden" aria-hidden>
          <Trans>Upload</Trans>
        </span>
      </Button>
      <Button
        size="sm"
        disabled={files.creating || !files.scratch.catalog}
        onClick={() => void files.createScratch()}
        aria-label={t`New note`}
        className="[@media(pointer:coarse)]:min-h-11"
      >
        <FilePlus aria-hidden />
        <span className="max-sm:hidden" aria-hidden>
          <Trans>New note</Trans>
        </span>
      </Button>
    </>
  );
}

export function WorkFilesView({
  projectId,
  work,
  commands,
  search,
  files,
}: {
  projectId: string;
  work: AddressableWork;
  commands: ProjectRouteCommands;
  search: string;
  files: WorkFiles;
}) {
  const { scratch, uploads } = files;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const scratchDelete = useDeleteConfirmation({ projectId, workId: work.id, scheme: "scratch" });
  const scratchRoot = scratch.catalog?.root.entryId;
  const scratchFolders =
    scratch.catalog && scratchRoot
      ? scratch.catalog
          .children(scratchRoot)
          .filter((node): node is CatalogDirectory => node.kind === "dir")
      : [];
  const scratchFiles =
    scratch.catalog
      ?.files()
      .filter(
        (file) =>
          file.parentId === scratchRoot ||
          [...expanded].some((path) => file.path.startsWith(`${path}/`)),
      ) ?? [];
  const matchesSearch = workFileSearch(search);
  const visible = filterWorkFileGroups(
    {
      scratch: [...scratchFolders, ...scratchFiles],
      uploads: uploads.catalog?.files() ?? [],
    },
    matchesSearch,
  );
  const toggleFolder = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole tab accepts dropped files; the Upload button is the keyboard path.
    <div
      className={cn(
        "-mx-2 min-w-0 rounded-lg px-2 [--row-rule-inset:--spacing(2)]",
        dragging && "bg-dropdown-hover outline-2 outline-dashed outline-border",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void files.submitFiles(event.dataTransfer.files);
      }}
    >
      <Drafts projectId={projectId} work={work} commands={commands} matchesSearch={matchesSearch} />
      <Group label={t`Scratch`}>
        {scratch.isError ? (
          <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
        ) : !scratch.catalog ? (
          <RowsLoading />
        ) : visible.scratch.length ? (
          <ul className="-mx-2 min-w-0">
            {visible.scratch.map((node, index) => (
              <li
                key={node.entryId}
                className={cn(
                  "relative",
                  (index < visible.scratch.length - 1 || Boolean(files.scratchNoteAttempt)) &&
                    "row-rule",
                )}
              >
                {node.kind === "dir" ? (
                  <FolderRow
                    folder={node}
                    open={expanded.has(node.path)}
                    onToggle={() => toggleFolder(node.path)}
                  />
                ) : (
                  <CatalogFileRow
                    projectId={projectId}
                    work={work}
                    scheme="scratch"
                    file={node}
                    siblingNames={catalogSiblingNames(scratch.catalog, node)}
                    renaming={files.renaming === node.path}
                    onRename={files.setRenaming}
                    onDelete={() =>
                      scratchDelete.requestDelete({
                        kind: "file",
                        name: node.name,
                        path: node.path,
                        documentId: node.documentId,
                      })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        ) : files.scratchNoteAttempt ? null : (
          <Quiet>
            {search ? (
              <Trans>No scratch notes match “{search}”.</Trans>
            ) : (
              <Trans>No scratch notes yet.</Trans>
            )}
          </Quiet>
        )}
        {files.scratchNoteAttempt ? (
          <ul className="-mx-2 min-w-0">
            <li className="relative">
              <FileAttemptRow
                name={files.scratchNoteAttempt.name}
                state={files.scratchNoteAttempt.state}
                pendingLabel={<Trans>Creating…</Trans>}
                failureLabel={<Trans>Couldn’t create note</Trans>}
                onRetry={files.retryScratchNote}
                onDismiss={files.dismissScratchNote}
              />
            </li>
          </ul>
        ) : null}
      </Group>
      <Group label={t`Uploads`}>
        {uploads.isError ? (
          <InlineErrorRow message={t`Uploads couldn’t load`} onRetry={uploads.refetch} />
        ) : !uploads.catalog ? (
          <RowsLoading />
        ) : visible.uploads.length || files.attempts.length ? (
          <ul className="-mx-2 min-w-0">
            {visible.uploads.map((file, index) => (
              <li
                key={file.entryId}
                className={cn(
                  "relative",
                  (index < visible.uploads.length - 1 || files.attempts.length > 0) && "row-rule",
                )}
              >
                <CatalogFileRow
                  projectId={projectId}
                  work={work}
                  scheme="uploads"
                  file={file}
                  siblingNames={catalogSiblingNames(uploads.catalog, file)}
                  renaming={files.renaming === file.path}
                  onRename={files.setRenaming}
                />
              </li>
            ))}
            {files.attempts.map((attempt, index) => (
              <li
                key={attempt.key}
                className={cn("relative", index < files.attempts.length - 1 && "row-rule")}
              >
                <FileAttemptRow
                  name={attempt.name}
                  state={attempt.state === "uploading" ? "pending" : "failed"}
                  pendingLabel={<Trans>Uploading…</Trans>}
                  failureLabel={<Trans>Couldn’t upload</Trans>}
                  onDismiss={() => files.dismissAttempt(attempt.key)}
                />
              </li>
            ))}
          </ul>
        ) : search ? (
          <Quiet>
            <Trans>No uploads match “{search}”.</Trans>
          </Quiet>
        ) : null}
        {!search ? (
          <button
            type="button"
            onClick={files.chooseFiles}
            className="focus-ring mt-2 flex w-full items-center gap-3 rounded-md border border-dashed border-border px-2 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-ink-subtle hover:text-foreground motion-reduce:transition-none"
          >
            <Upload className="size-4 shrink-0" aria-hidden />
            <Trans>Drop files here or choose from your device</Trans>
          </button>
        ) : null}
      </Group>
      <DeleteConfirmationDialog
        target={scratchDelete.target}
        isPending={scratchDelete.isPending}
        error={scratchDelete.error}
        onCancel={scratchDelete.cancel}
        onConfirm={() => void scratchDelete.confirm()}
      />
    </div>
  );
}

function Drafts({
  projectId,
  work,
  commands,
  matchesSearch,
}: {
  projectId: string;
  work: AddressableWork;
  commands: ProjectRouteCommands;
  matchesSearch: WorkFileSearch;
}) {
  const query = useWorkDrafts(projectId, work.id);
  const groups = activeWorkDraftGroups(
    usePostApplyDraftGroupProjections(query.groups, projectId, work.id).commandEligibleGroups,
  );
  const visible = groups.filter((group) =>
    matchesSearch(group.documentName || group.contextPath || ""),
  );
  // Drafts appear only when there is something to review; never a loading flash.
  if (query.status !== "error" && visible.length === 0) return null;
  return (
    <Group label={t`Drafts to review`}>
      {query.status === "error" ? (
        <InlineErrorRow
          message={t`Pending drafts couldn’t load`}
          onRetry={query.refetch}
          actionLabel={t`Retry Pending drafts`}
        />
      ) : (
        <ul className="-mx-2 min-w-0">
          {visible.map((group, index) => (
            <li
              key={group.documentId}
              className={cn("relative", index < visible.length - 1 && "row-rule")}
            >
              <button
                type="button"
                className={rowClass}
                disabled={!group.contextPath}
                onClick={() => {
                  if (group.contextPath)
                    void commands.openWorkContext(
                      {
                        kind: "work-context",
                        workId: work.id,
                        scheme: "manuscript",
                        path: group.contextPath,
                      },
                      { replace: false },
                    );
                }}
              >
                <RowIcon icon={fileKindIcon(group.documentName || group.contextPath || "")} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {group.documentName || group.contextPath || t`Untitled manuscript`}
                </span>
                <span className="shrink-0 text-xs text-jade-text">
                  <Plural
                    value={group.drafts.length}
                    one="# pending draft"
                    other="# pending drafts"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

const rowClass =
  "focus-ring flex min-h-10 w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors motion-reduce:transition-none hover:bg-dropdown-hover";

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-[18px] shrink-0 place-items-center text-ink-subtle">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function FolderRow({
  folder,
  open,
  onToggle,
}: {
  folder: CatalogDirectory;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className={rowClass} aria-expanded={open} onClick={onToggle}>
      <RowIcon icon={open ? FolderOpen : Folder} />
      <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
    </button>
  );
}

function CatalogFileRow({
  projectId,
  work,
  scheme,
  file,
  siblingNames,
  renaming,
  onRename,
  onDelete,
}: {
  projectId: string;
  work: AddressableWork;
  scheme: Scheme;
  file: CatalogFile;
  siblingNames: readonly string[];
  renaming: boolean;
  onRename: (path: string | null) => void;
  onDelete?: () => void;
}) {
  const openFile = useOpenFileInDock(work.id);
  const docked = useDockViewStore(
    (state) => state.workFile?.workId === work.id && state.workFile.tab.path === file.path,
  );
  const folder = file.path.includes("/") ? file.path.replace(/\/[^/]+$/, "") : "";
  if (renaming)
    return (
      <div className="flex min-h-10 items-center gap-3 px-2 py-1.5 text-sm font-medium text-foreground">
        <RowIcon icon={fileKindIcon(file)} />
        <InlineRename
          projectId={projectId}
          workId={work.id}
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
  const open = () => openFile(viewerTabForCatalogFile(file, scheme, work.id));
  return (
    <ContextEntryMenu allowCreate={false} allowDelete={Boolean(onDelete)} onAction={onAction}>
      <div
        className={cn("group relative flex min-w-0 items-center", docked && "rounded-md bg-muted")}
      >
        <button
          type="button"
          className={cn(rowClass, "pr-10")}
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
        <div className="absolute right-1">
          <EntryKebabButton
            allowCreate={false}
            allowDelete={Boolean(onDelete)}
            onAction={onAction}
            align="end"
          />
        </div>
      </div>
    </ContextEntryMenu>
  );
}

function FileAttemptRow({
  name,
  state,
  pendingLabel,
  failureLabel,
  onRetry,
  onDismiss,
}: {
  name: string;
  state: "pending" | "creating" | "uploading" | "failed";
  pendingLabel: React.ReactNode;
  failureLabel: React.ReactNode;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex min-h-10 min-w-0 items-center gap-3 px-2 py-1.5 text-sm">
      <RowIcon icon={fileKindIcon(name)} />
      <span className="min-w-0 flex-1 truncate font-medium text-muted-foreground">{name}</span>
      {state !== "failed" ? (
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
  scheme: Scheme;
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

/** A group label in the recency-list rank, with the recency list's rhythm. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 pb-2 [section+&]:pt-5" aria-label={label}>
      <h2 className="pb-2">
        <SectionLabel variant="group">{label}</SectionLabel>
      </h2>
      {children}
    </section>
  );
}

function RowsLoading() {
  return (
    <div role="status" aria-label={t`Loading`} className="space-y-3 py-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-muted-foreground">{children}</p>;
}
