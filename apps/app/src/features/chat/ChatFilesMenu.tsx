/** Chat Files combines existing shared Scratch with this chat's uploads and source-chat link. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { isHandoffSeed, readHandoffSeed } from "@meridian/contracts/threads";
import { FileImage, FileText, FileType, Paperclip, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { deleteChatUpload } from "@/client/api/context-upload-api";
import { type ChatUpload, useChatUploads } from "@/client/query/useChatUploads";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { topChatOf } from "@/client/query/useTopChat";
import { useThreadStore } from "@/client/stores";
import { useDensityPopoverCollisionProps } from "@/components/ui/density-popover-collision";
import { dropdownSurfaceVariants } from "@/components/ui/dropdown-presentation";
import { IconButton } from "@/components/ui/icon-button";
import { handleListKeys } from "@/components/ui/list-keys";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { PickerResults, PickerSection } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MenuScratchSection } from "@/features/project/chat/ChatScratch";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import {
  type EntriesRoute,
  TreeDropScope,
  useTreeDropTarget,
} from "@/features/project/context/tree-drop/tree-drop";
import { cn } from "@/lib/utils";
import { attachedAgo, uploadTypeLabel } from "./chat-upload-display";
import { insertIntoChatComposer, removeFromChatComposer } from "./composer-insertion";
import { useInheritedView } from "./derivation/inherited-view";
import { SourceChatLink, useSourceThread } from "./derivation/SourceChatLink";

const NO_TURNS: never[] = [];

/** The Scratch tree's rows and the uploads' rows, walked as one list. */
const FILES_MENU_STOPS = '[role="button"][tabindex="0"], [data-list-item]';

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
  if (!threadId || !topChat) return null;
  return (
    <FilesDropdown
      projectId={projectId}
      threadId={threadId}
      chatId={topChat.chatId}
      chatThread={chatThread}
    />
  );
}

function FilesDropdown({
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
  const { uploads } = useChatUploads(projectId, chatId);
  const continuesFrom = useContinuesFrom(chatThread);
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

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t`Files`}
          aria-expanded={open}
          aria-haspopup="dialog"
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-ink-fill hover:text-foreground popup-open:bg-ink-fill-strong popup-open:text-foreground coarse:min-h-11"
        >
          <Paperclip className="size-3.5" aria-hidden />
          <span aria-hidden="true">
            <Trans>Files</Trans>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...densityPopoverCollisionProps}
        ref={contentRef}
        align="end"
        className={cn(
          dropdownSurfaceVariants({ measure: "catalog" }),
          "text-tier-chat w-[min(22rem,calc(100vw-1.5rem))]",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.querySelector<HTMLElement>(FILES_MENU_STOPS)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (focusHandoff.current) event.preventDefault();
          focusHandoff.current = false;
        }}
        onKeyDown={(event) => handleListKeys(event, FILES_MENU_STOPS)}
      >
        {continuesFrom ? (
          <p
            className="px-2 py-1.5 text-sm text-muted-foreground"
            onClickCapture={() => close(false)}
          >
            <ContinuesFrom source={continuesFrom} />
          </p>
        ) : null}
        <PickerResults>
          <MenuScratchSection
            projectId={projectId}
            threadId={threadId}
            onPicked={() => close(false)}
          />
          <UploadsRefuseDrops>
            <PickerSection
              label={t`Uploads`}
              state={
                rows.length === 0 ? (
                  <ListLine density="menu" iconSlot>
                    <Trans>No files attached in this chat yet.</Trans>
                  </ListLine>
                ) : null
              }
            >
              {rows.map((upload) => (
                <UploadRow
                  key={upload.documentId}
                  upload={upload}
                  now={now}
                  canDelete={upload.deletion !== null && !used.has(upload.documentId)}
                  failed={failed.has(upload.documentId)}
                  onInsert={() => insert(upload)}
                  onDelete={() => remove(upload)}
                />
              ))}
            </PickerSection>
          </UploadsRefuseDrops>
        </PickerResults>
      </PopoverContent>
    </Popover>
  );
}

function UploadRow({
  upload,
  now,
  canDelete,
  failed,
  onInsert,
  onDelete,
}: {
  upload: ChatUpload;
  now: number;
  canDelete: boolean;
  failed: boolean;
  onInsert: () => void;
  onDelete: () => void;
}) {
  const Icon = iconFor(upload);
  const name = upload.name;
  const drag = useReferenceDrag({ ref: { kind: "file", id: upload.documentId }, name });
  const failure = failed ? t`Couldn’t delete this file. Try again.` : null;
  return (
    <li>
      <ListRow
        density="menu"
        onOpen={onInsert}
        controlProps={{ ...drag, "aria-label": t`Add ${name} to your message` }}
        leading={<Icon aria-hidden className="text-muted-foreground" />}
        title={name}
        detail={
          failure ? (
            <span aria-hidden="true" className="text-destructive">
              {failure}
            </span>
          ) : (
            uploadTypeLabel(upload.fileType)
          )
        }
        meta={failure ? null : attachedAgo(upload.attachedAt, now)}
        actions={
          canDelete ? (
            <IconButton size="xs" label={t`Delete ${name}`} onClick={onDelete} className="mr-1">
              <Trash2 aria-hidden />
            </IconButton>
          ) : null
        }
        // The failure replaces the row's second line; this announces it without adding layout.
        below={
          <span role="status" className="sr-only">
            {failure}
          </span>
        }
      />
    </li>
  );
}

/**
 * Uploads is out-only: its files can be moved or copied elsewhere, but nothing is dropped into it.
 * The section is a drop target that always refuses, so the pointer says why instead of showing a
 * silent no-drop cursor.
 */
const refuseUploadsDrops: EntriesRoute = {
  verdict: () => ({
    kind: "refuse",
    label: t`Files move or copy out of Uploads; they can't be dropped into it`,
  }),
  drop: () => {},
};

const UPLOADS_TARGET = { scheme: "uploads", catalogRootId: "uploads", folder: null } as const;

function UploadsRefuseDrops({ children }: { children: ReactNode }) {
  const routes = useMemo(() => ({ entries: refuseUploadsDrops }), []);
  return (
    <TreeDropScope routes={routes}>
      <UploadsDropArea>{children}</UploadsDropArea>
    </TreeDropScope>
  );
}

function UploadsDropArea({ children }: { children: ReactNode }) {
  const { dropProps } = useTreeDropTarget(UPLOADS_TARGET);
  return <div {...dropProps}>{children}</div>;
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
