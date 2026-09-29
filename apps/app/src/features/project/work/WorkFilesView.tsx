/**
 * Work Files tab: drafts to review, scratch notes and uploads as one grouped
 * list in the same row grammar as the Chats tab and the Editor's recents.
 * `useWorkFiles` owns the tab's state so the page toolbar can host its actions;
 * files on their way in are `useWorkFileIntake`'s.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { FilePlus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { CatalogDirectory } from "@/client/query/context-catalog-projection";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import type { AddressableWork } from "@/client/query/useWorks";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog, useDeleteConfirmation } from "../context/ContextEntryActions";
import { RuledList, type RuledRow } from "../RuledList";
import type { ProjectRouteCommands } from "../routing/project-route";
import { useWorkFileIntake } from "./use-work-file-intake";
import { WorkDrafts } from "./WorkDrafts";
import { WorkFileGroup, WorkFileGroupLoading, WorkFileGroupNote } from "./WorkFileGroup";
import { CatalogFileRow, FileAttemptRow, FolderRow } from "./WorkFileRows";
import { catalogSiblingNames, filterWorkFileGroups, workFileSearch } from "./work-files-model";

export function useWorkFiles(projectId: string, work: AddressableWork) {
  const scratch = useContextCatalogView(projectId, "scratch", { workId: work.id });
  const uploads = useContextCatalogView(projectId, "uploads", { workId: work.id });
  const intake = useWorkFileIntake(projectId, work.id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const scratchNames = () =>
    scratch.catalog?.children(scratch.catalog.root.entryId).map((entry) => entry.name) ?? [];
  // A new note opens for naming as soon as the server has it. It sits at the
  // Scratch root, and catalog paths are rooted.
  const named = (name: string | null) => {
    if (name) setRenaming(`/${name}`);
  };
  return {
    scratch,
    uploads,
    intake,
    renaming,
    setRenaming,
    picker,
    chooseFiles: () => picker.current?.click(),
    createNote: () => void intake.createNote(scratchNames()).then(named),
    retryNote: () => void intake.retryNote().then(named),
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
          if (event.target.files) void files.intake.submitFiles(event.target.files);
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
        disabled={files.intake.note?.state === "pending" || !files.scratch.catalog}
        onClick={files.createNote}
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
  const { scratch, uploads, intake } = files;
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

  const scratchRows: RuledRow[] = visible.scratch.map((node) => ({
    key: node.entryId,
    node:
      node.kind === "dir" ? (
        <FolderRow
          folder={node}
          open={expanded.has(node.path)}
          onToggle={() => toggleFolder(node.path)}
        />
      ) : (
        <CatalogFileRow
          projectId={projectId}
          workId={work.id}
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
      ),
  }));
  if (intake.note)
    scratchRows.push({
      key: intake.note.key,
      node: (
        <FileAttemptRow
          attempt={intake.note}
          pendingLabel={<Trans>Creating…</Trans>}
          failureLabel={<Trans>Couldn’t create note</Trans>}
          onRetry={files.retryNote}
          onDismiss={intake.dismissNote}
        />
      ),
    });
  const uploadRows: RuledRow[] = [
    ...visible.uploads.map((file) => ({
      key: file.entryId,
      node: (
        <CatalogFileRow
          projectId={projectId}
          workId={work.id}
          scheme="uploads"
          file={file}
          siblingNames={catalogSiblingNames(uploads.catalog, file)}
          renaming={files.renaming === file.path}
          onRename={files.setRenaming}
        />
      ),
    })),
    ...intake.uploads.map((attempt) => ({
      key: attempt.key,
      node: (
        <FileAttemptRow
          attempt={attempt}
          pendingLabel={<Trans>Uploading…</Trans>}
          failureLabel={<Trans>Couldn’t upload</Trans>}
          onDismiss={() => intake.dismissUpload(attempt.key)}
        />
      ),
    })),
  ];

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
        void intake.submitFiles(event.dataTransfer.files);
      }}
    >
      <WorkDrafts
        projectId={projectId}
        workId={work.id}
        commands={commands}
        matchesSearch={matchesSearch}
      />
      <WorkFileGroup label={t`Scratch`}>
        {scratch.isError ? (
          <InlineErrorRow message={t`Scratch couldn’t load`} onRetry={scratch.refetch} />
        ) : !scratch.catalog ? (
          <WorkFileGroupLoading />
        ) : scratchRows.length ? (
          <RuledList className="-mx-2" rows={scratchRows} />
        ) : (
          <WorkFileGroupNote>
            {search ? (
              <Trans>No scratch notes match “{search}”.</Trans>
            ) : (
              <Trans>No scratch notes yet.</Trans>
            )}
          </WorkFileGroupNote>
        )}
      </WorkFileGroup>
      <WorkFileGroup label={t`Uploads`}>
        {uploads.isError ? (
          <InlineErrorRow message={t`Uploads couldn’t load`} onRetry={uploads.refetch} />
        ) : !uploads.catalog ? (
          <WorkFileGroupLoading />
        ) : uploadRows.length ? (
          <RuledList className="-mx-2" rows={uploadRows} />
        ) : search ? (
          <WorkFileGroupNote>
            <Trans>No uploads match “{search}”.</Trans>
          </WorkFileGroupNote>
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
      </WorkFileGroup>
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
