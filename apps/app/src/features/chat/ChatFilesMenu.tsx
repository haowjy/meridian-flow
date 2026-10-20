/**
 * ChatFilesMenu — the chat's top-bar dropdown of the files in this chat.
 *
 * Uploads are the files the writer attached: a row adds one to the message being written (the
 * chip the `@` picker inserts), opens it in the viewer, or deletes it while no sent message has
 * used it. Notes are the chat's own Scratch folder: each row opens the note. A subagent shows
 * its top chat's uploads and its own notes. A fork or handoff owns its own files and names the
 * chat it continues from. The control appears once the chat has a file or a source to point
 * back to, so a chat with nothing to show carries no extra control.
 */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ContextOwner, Thread } from "@meridian/contracts/protocol";
import { isHandoffSeed, readHandoffSeed } from "@meridian/contracts/threads";
import { FileImage, FileText, FileType, PanelRightOpen, Paperclip, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { deleteChatUpload } from "@/client/api/upload-intake-api";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
} from "@/client/query/context-catalog-projection";
import { type ChatUpload, useChatUploads } from "@/client/query/useChatUploads";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { topChatOf } from "@/client/query/useTopChat";
import { useThreadStore } from "@/client/stores";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import {
  dropdownResultsClass,
  dropdownRowContainerClass,
  dropdownRowVariants,
  dropdownSurfaceVariants,
} from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SectionLabel } from "@/components/ui/section-label";
import { useChatScratchSource } from "@/features/project/chat/use-chat-scratch-source";
import { serverTabFromFile } from "@/features/project/context/context-tab-from-file";
import { useOpenChatResource } from "@/features/project/context/open-chat-document";
import { useOpenScratchNote } from "@/features/project/dock/use-open-scratch-note";
import { cn } from "@/lib/utils";
import { attachedAgo, uploadTypeLabel } from "./chat-upload-display";
import { insertIntoChatComposer, removeFromChatComposer } from "./composer-insertion";
import { useInheritedView } from "./derivation/inherited-view";
import { SourceChatLink, useSourceThread } from "./derivation/SourceChatLink";

const NO_TURNS: never[] = [];

export function ChatFilesMenu({
  projectId,
  threadId,
}: {
  projectId: string;
  threadId: string | null;
}) {
  const { threads } = useProjectThreads(projectId, { enabled: threadId !== null });
  const thread = threadId
    ? (threads?.find((candidate) => candidate.id === threadId) ?? null)
    : null;
  const topChat = topChatOf(thread, threads);
  // A fork or handoff is a primary: its origin is read on the chat that owns the files.
  const chatThread = topChat ? (threads?.find((c) => c.id === topChat.chatId) ?? null) : null;
  const scratch = useChatScratchSource(projectId, threadId);
  const scratchCatalog = useContextCatalogView(projectId, "scratch", {
    ...(scratch?.owner ?? {}),
    enabled: scratch !== null,
  });
  const notes = useChatNotes(scratchCatalog.catalog, thread?.ref ?? null);
  if (!threadId || !topChat) return null;
  return (
    <FilesDropdown
      projectId={projectId}
      threadId={threadId}
      chatId={topChat.chatId}
      chatThread={chatThread}
      notes={notes}
      owner={scratch?.owner ?? {}}
    />
  );
}

type ChatNote = { file: CatalogFile; label: string };

/** The chat's own notes folder: the folder whose address is its thread root. */
function useChatNotes(catalog: CatalogContextView | null, ref: string | null): ChatNote[] {
  return useMemo(() => {
    if (!catalog || !ref) return [];
    const folder = catalog
      .children(catalog.root.entryId)
      .find(
        (node): node is CatalogDirectory => node.kind === "dir" && threadRootRef(node.uri) === ref,
      );
    if (!folder) return [];
    return catalog
      .files()
      .filter((file) => file.path.startsWith(`${folder.path}/`))
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ file, label: file.path.slice(folder.path.length + 1) }));
  }, [catalog, ref]);
}

function threadRootRef(uri: string): string | null {
  const parsed = parseContextUri(uri);
  return parsed.ok && parsed.value.path === "" ? (parsed.value.threadRef ?? null) : null;
}

function FilesDropdown({
  projectId,
  threadId,
  chatId,
  chatThread,
  notes,
  owner,
}: {
  projectId: string;
  threadId: string;
  chatId: string;
  chatThread: Thread | null;
  notes: readonly ChatNote[];
  owner: ContextOwner;
}) {
  const { uploads } = useChatUploads(projectId, chatId);
  const continuesFrom = useContinuesFrom(chatThread);
  const openResource = useOpenChatResource(projectId);
  const openNote = useOpenScratchNote();
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const now = useThreadStore((state) => state.now);
  const [open, setOpen] = useState(false);
  // Rows the writer deleted stay gone at once. A refused delete brings its row back: a file a sent
  // message used loses its delete action (the catalog catches up), a failed one says so in the
  // row's own second line.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const contentRef = useRef<HTMLDivElement>(null);
  const focusHandoff = useRef(false);

  // A failure belongs to one opening of the menu.
  useEffect(() => {
    if (open) setFailed(new Set());
  }, [open]);

  const rows = uploads.filter((upload) => !deleted.has(upload.documentId));
  if (rows.length === 0 && notes.length === 0 && !continuesFrom && !open) return null;

  const close = (returnFocusToComposer: boolean) => {
    focusHandoff.current = returnFocusToComposer;
    setOpen(false);
  };

  const insert = (upload: ChatUpload) => {
    close(true);
    if (upload.reference) insertIntoChatComposer(threadId, upload.reference, upload.fileKind);
  };

  const remove = (upload: ChatUpload) => {
    const { deletion } = upload;
    if (!deletion) return;
    setDeleted((current) => new Set(current).add(upload.documentId));
    setFailed((current) => without(current, upload.documentId));
    const bringBack = (reason: "used" | "failed") => {
      setDeleted((current) => without(current, upload.documentId));
      const mark = reason === "used" ? setUsed : setFailed;
      mark((current) => new Set(current).add(upload.documentId));
    };
    void deleteChatUpload(
      { projectId, chatId },
      {
        intakeId: deletion.intakeId,
        documentId: upload.documentId,
        uri: upload.uri,
        expectedRevision: deletion.locationRevision,
      },
    ).then(
      (result) => {
        if (result.kind === "deleted" || result.kind === "already_deleted") {
          // A gone file must not ride along on the message being written.
          removeFromChatComposer(threadId, upload.documentId);
          return;
        }
        bringBack(result.kind === "already_used" ? "used" : "failed");
      },
      () => bringBack("failed"),
    );
  };

  const openNoteFile = (note: ChatNote) => {
    const tab = serverTabFromFile("scratch", note.file, owner);
    if (!tab) return;
    close(false);
    openNote(tab);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rowKeys = ["ArrowDown", "ArrowUp", "Home", "End"];
    const target = event.target as HTMLElement;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      // Within a row: the file's own button, then its actions.
      const row = target.closest<HTMLElement>("[data-upload-item]");
      const stops = Array.from(row?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      const index = stops.indexOf(target);
      if (index < 0) return;
      const next = stops[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      return;
    }
    if (!rowKeys.includes(event.key)) return;
    const primaries = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-file-row]"),
    );
    if (primaries.length === 0) return;
    const current = primaries.indexOf(
      target.closest<HTMLElement>("[data-upload-item]")?.querySelector("[data-file-row]") ?? target,
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? primaries.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % primaries.length
            : (current <= 0 ? primaries.length : current) - 1;
    event.preventDefault();
    primaries[next]?.focus();
  };

  const count = rows.length + notes.length;
  const label = count > 0 ? plural(count, { one: "# file", other: "# files" }) : t`Files`;
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? t`Files in this chat, ${count}` : t`Files in this chat`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [@media(pointer:coarse)]:min-h-11"
        >
          <Paperclip className="size-3.5" aria-hidden />
          <span aria-hidden="true">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        ref={contentRef}
        align="end"
        className={cn(
          dropdownSurfaceVariants({ measure: "catalog", page: null }),
          "text-tier-chat w-[min(22rem,calc(100vw-1.5rem))] p-0",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>("[data-file-row]")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (focusHandoff.current) event.preventDefault();
          focusHandoff.current = false;
        }}
        onKeyDown={handleKeyDown}
      >
        {continuesFrom ? (
          <p className="px-3 pt-3 text-sm text-ink-muted" onClickCapture={() => close(false)}>
            <ContinuesFrom source={continuesFrom} />
          </p>
        ) : null}
        <div className={cn(dropdownResultsClass, "max-h-72 px-1 py-2")}>
          {rows.length === 0 && notes.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>No files in this chat yet.</Trans>
            </p>
          ) : null}
          {rows.length > 0 ? (
            <section aria-label={notes.length > 0 ? t`Uploads` : undefined}>
              {notes.length > 0 ? (
                <SectionLabel variant="group" className="mb-1 block px-3">
                  <Trans>Uploads</Trans>
                </SectionLabel>
              ) : null}
              <ul className="flex flex-col gap-[var(--chat-space-row)]">
                {rows.map((upload) => (
                  <UploadRow
                    key={upload.documentId}
                    upload={upload}
                    now={now}
                    canDelete={upload.deletion !== null && !used.has(upload.documentId)}
                    failed={failed.has(upload.documentId)}
                    onInsert={() => insert(upload)}
                    onOpen={
                      openResource
                        ? () => {
                            close(false);
                            void openResource({
                              documentId: upload.documentId,
                              disposition: "current",
                            });
                          }
                        : null
                    }
                    onDelete={() => remove(upload)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {notes.length > 0 ? (
            <section
              aria-label={rows.length > 0 ? t`Notes` : undefined}
              className={rows.length > 0 ? "mt-2 border-t border-border-subtle pt-2" : undefined}
            >
              {rows.length > 0 ? (
                <SectionLabel variant="group" className="mb-1 block px-3">
                  <Trans>Notes</Trans>
                </SectionLabel>
              ) : null}
              <ul className="flex flex-col gap-[var(--chat-space-row)]">
                {notes.map((note) => (
                  <ChatNoteRow
                    key={note.file.documentId}
                    note={note}
                    onOpen={() => openNoteFile(note)}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChatNoteRow({ note, onOpen }: { note: ChatNote; onOpen: () => void }) {
  return (
    <li>
      <button
        data-file-row
        type="button"
        onClick={onOpen}
        aria-label={t`Open ${note.label}`}
        className={cn(
          dropdownRowVariants({ kind: "descriptive", interactive: false }),
          "flex min-h-10 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-dropdown-hover",
        )}
      >
        <FileText className="text-muted-foreground" aria-hidden />
        <span className="truncate">{note.label}</span>
      </button>
    </li>
  );
}

function UploadRow({
  upload,
  now,
  canDelete,
  failed,
  onInsert,
  onOpen,
  onDelete,
}: {
  upload: ChatUpload;
  now: number;
  canDelete: boolean;
  failed: boolean;
  onInsert: () => void;
  /** Null where this host has no viewer for an upload. */
  onOpen: (() => void) | null;
  onDelete: () => void;
}) {
  const Icon = iconFor(upload);
  const name = upload.name;
  const failure = failed ? t`Couldn’t delete this file. Try again.` : null;
  return (
    <li data-upload-item className="relative flex flex-col">
      <div
        className={cn(
          dropdownRowContainerClass,
          "flex min-w-0 items-center transition-colors hover:bg-dropdown-hover",
        )}
      >
        <button
          data-file-row
          type="button"
          onClick={onInsert}
          aria-label={t`Add ${name} to your message`}
          className={cn(
            dropdownRowVariants({ kind: "descriptive", interactive: false }),
            "h-auto min-h-10 flex-1 py-1.5",
          )}
        >
          <Icon aria-hidden className="text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{upload.name}</span>
            {failure ? (
              <span aria-hidden="true" className="truncate text-meta text-destructive">
                {failure}
              </span>
            ) : (
              <span className="flex min-w-0 justify-between gap-3 text-meta text-ink-subtle">
                <span className="truncate">{uploadTypeLabel(upload.fileType)}</span>
                <span className="shrink-0 tabular-nums">{attachedAgo(upload.attachedAt, now)}</span>
              </span>
            )}
          </span>
        </button>
        {canDelete ? (
          <IconButton
            size="xs"
            aria-label={t`Delete ${name}`}
            title={t`Delete ${name}`}
            onClick={onDelete}
            className="[@media(pointer:coarse)]:size-11"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
        {onOpen ? (
          <IconButton
            size="xs"
            aria-label={t`Open ${name}`}
            title={t`Open ${name}`}
            onClick={onOpen}
            className="mr-1 [@media(pointer:coarse)]:size-11"
          >
            <PanelRightOpen className="size-3.5" aria-hidden />
          </IconButton>
        ) : null}
      </div>
      {/* The failure replaces the row's second line; this announces it without adding layout. */}
      <span role="status" className="sr-only">
        {failure}
      </span>
    </li>
  );
}

function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(id);
  return next;
}

function iconFor(upload: ChatUpload) {
  if (upload.fileKind === "document") return FileText;
  if (upload.fileType === "pdf") return FileType;
  if (upload.fileType === "docx" || upload.fileType === "binary") return FileText;
  return FileImage;
}

type ContinuedSource = { threadId: string; title: string | null; trashed: boolean | null };

function ContinuesFrom({ source }: { source: ContinuedSource }) {
  const found = useSourceThread(source.threadId, source.title);
  return (
    <Trans>
      Continues from{" "}
      <SourceChatLink
        threadId={source.threadId}
        title={found.title}
        trashed={found.trashed}
        fallbackName={t`the source chat`}
      />
    </Trans>
  );
}

/**
 * The chat a fork or handoff continues from: a fork's is the owner of the turn it was cut at,
 * a handoff's is named on its brief. Null for any other chat.
 */
function useContinuesFrom(chat: Thread | null): ContinuedSource | null {
  const inherited = useInheritedView(chat, null);
  const turns = useThreadStore((state) =>
    chat ? state.syncedByThread[chat.id]?.turns : undefined,
  );
  if (!chat?.originType) return null;
  if (chat.originType === "fork") {
    const view = inherited.view;
    const ownerId = chat.originTurnId
      ? view?.transcript.ownerByTurnId.get(chat.originTurnId)
      : null;
    if (!view || !ownerId) return null;
    const owner = view.owners.get(ownerId);
    return { threadId: ownerId, title: owner?.title ?? null, trashed: owner?.trashed ?? null };
  }
  const seed = (turns ?? NO_TURNS).find(isHandoffSeed);
  const facts = seed ? readHandoffSeed(seed) : null;
  return facts ? { threadId: facts.sourceThreadId, title: facts.sourceTitle, trashed: null } : null;
}
