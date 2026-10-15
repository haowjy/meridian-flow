/**
 * ChatUploadsMenu — the chat's top-bar dropdown of the files the writer attached in this chat.
 *
 * A row adds the file to the message being written (the chip the `@` picker inserts), can open
 * it in the viewer, and, while no sent message has used it, deletes it. A subagent shows its top
 * chat's files. A fork or handoff owns its own files and names the chat it continues from. The
 * control appears once the chat has a file (or a source to point back to), so a chat with
 * nothing to show carries no extra control.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { isHandoffSeed, readHandoffSeed } from "@meridian/contracts/threads";
import { FileImage, FileText, FileType, PanelRightOpen, Paperclip, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { deleteChatUpload } from "@/client/api/upload-intake-api";
import { type ChatUpload, useChatUploads } from "@/client/query/useChatUploads";
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
import { useOpenChatDocument } from "@/features/project/context/open-chat-document";
import { cn } from "@/lib/utils";
import { attachedAgo, uploadTypeLabel } from "./chat-upload-display";
import { insertIntoChatComposer, removeFromChatComposer } from "./composer-insertion";
import { useInheritedView } from "./derivation/inherited-view";
import { SourceChatLink, useSourceThread } from "./derivation/SourceChatLink";

const NO_TURNS: never[] = [];

export function ChatUploadsMenu({
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
  if (!threadId || !topChat) return null;
  return (
    <UploadsDropdown
      projectId={projectId}
      threadId={threadId}
      chatId={topChat.chatId}
      chatThread={chatThread}
    />
  );
}

function UploadsDropdown({
  projectId,
  threadId,
  chatId,
  chatThread,
}: {
  projectId: string;
  threadId: string;
  chatId: string;
  chatThread: Thread | null;
}) {
  const { uploads, refetch } = useChatUploads(projectId, chatId);
  const continuesFrom = useContinuesFrom(chatThread);
  const openDocument = useOpenChatDocument(projectId);
  const densityPopoverCollisionProps = useDensityPopoverCollisionProps();
  const now = useThreadStore((state) => state.now);
  const [open, setOpen] = useState(false);
  // Rows the writer deleted stay gone at once; a refused delete brings its row back with the reason.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const focusHandoff = useRef(false);

  // `used` changes with a send, which fires no catalog event: ask again each time it opens.
  useEffect(() => {
    if (!open) return;
    setRefusals(new Map());
    void refetch();
  }, [open, refetch]);

  const rows = uploads.filter((upload) => !deleted.has(upload.documentId));
  if (rows.length === 0 && !continuesFrom && !open) return null;

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
    const bringBack = (reason: string) => {
      setDeleted((current) => {
        const next = new Set(current);
        next.delete(upload.documentId);
        return next;
      });
      setRefusals((current) => new Map(current).set(upload.documentId, reason));
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
        if (result.kind === "already_used") {
          void refetch();
          bringBack(t`A sent message used this file, so it can’t be deleted.`);
        } else {
          void refetch();
          bringBack(t`This file changed, so it wasn’t deleted. Try again.`);
        }
      },
      () => bringBack(t`Couldn’t delete this file. Try again.`),
    );
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
      event.currentTarget.querySelectorAll<HTMLElement>("[data-upload-row]"),
    );
    if (primaries.length === 0) return;
    const current = primaries.indexOf(
      target.closest<HTMLElement>("[data-upload-item]")?.querySelector("[data-upload-row]") ??
        target,
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

  const count = rows.length;
  const label = count > 0 ? t`${count} files` : t`Files`;
  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? t`Files attached in this chat, ${count}` : t`Files in this chat`}
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
          contentRef.current?.querySelector<HTMLElement>("[data-upload-row]")?.focus();
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
          {rows.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              <Trans>No files attached in this chat yet.</Trans>
            </p>
          ) : (
            <ul className="flex flex-col gap-[var(--chat-space-row)]">
              {rows.map((upload) => (
                <UploadRow
                  key={upload.documentId}
                  upload={upload}
                  now={now}
                  refusal={refusals.get(upload.documentId) ?? null}
                  onInsert={() => insert(upload)}
                  onOpen={() => {
                    close(false);
                    void openDocument({ documentId: upload.documentId, disposition: "current" });
                  }}
                  onDelete={() => remove(upload)}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UploadRow({
  upload,
  now,
  refusal,
  onInsert,
  onOpen,
  onDelete,
}: {
  upload: ChatUpload;
  now: number;
  refusal: string | null;
  onInsert: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const Icon = iconFor(upload);
  const name = upload.name;
  const errorId = `upload-error-${upload.documentId}`;
  return (
    <li data-upload-item className="flex flex-col">
      <div
        className={cn(
          dropdownRowContainerClass,
          "flex min-w-0 items-center transition-colors hover:bg-dropdown-hover",
        )}
      >
        <button
          data-upload-row
          type="button"
          onClick={onInsert}
          aria-label={t`Add ${name} to your message`}
          aria-describedby={refusal ? errorId : undefined}
          className={cn(
            dropdownRowVariants({ kind: "descriptive", interactive: false }),
            "h-auto min-h-10 flex-1 py-1.5",
          )}
        >
          <Icon aria-hidden className="text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{upload.name}</span>
            <span className="flex min-w-0 justify-between gap-3 text-meta text-ink-subtle">
              <span className="truncate">{uploadTypeLabel(upload.fileType)}</span>
              <span className="shrink-0 tabular-nums">{attachedAgo(upload.attachedAt, now)}</span>
            </span>
          </span>
        </button>
        {upload.used ? null : (
          <IconButton
            size="xs"
            aria-label={t`Delete ${name}`}
            title={t`Delete ${name}`}
            onClick={onDelete}
            className="[@media(pointer:coarse)]:size-11"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </IconButton>
        )}
        <IconButton
          size="xs"
          aria-label={t`Open ${name}`}
          title={t`Open ${name}`}
          onClick={onOpen}
          className="mr-1 [@media(pointer:coarse)]:size-11"
        >
          <PanelRightOpen className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      {refusal ? (
        <p id={errorId} role="alert" className="px-2 pt-1 pb-0.5 text-meta text-destructive">
          {refusal}
        </p>
      ) : null}
    </li>
  );
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
  const turns = useThreadStore((state) => (chat ? state.turnsByThread[chat.id] : undefined));
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
