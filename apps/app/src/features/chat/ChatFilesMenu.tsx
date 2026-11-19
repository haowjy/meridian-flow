/** Chat Files combines existing shared Scratch with this chat's uploads and source-chat link. */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Thread } from "@meridian/contracts/protocol";
import { isHandoffSeed, readHandoffSeed } from "@meridian/contracts/threads";
import { FileImage, FileText, FileType, Paperclip, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
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
import { LIVE_VERSION } from "@/core/project-tree/tree-version";
import { MenuScratchSection } from "@/features/project/chat/ChatScratch";
import { schemeLabel } from "@/features/project/context/context-schemes";
import { LIVE_VIEW } from "@/features/project/context/entry-drag/entry";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import {
  type EntriesRoute,
  TreeDropScope,
  useTreeDropTarget,
} from "@/features/project/context/tree-drop/tree-drop";
import { useDeleteContextEntries } from "@/features/project/context/use-delete-context-entries";
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
  const deleteEntries = useDeleteContextEntries(projectId, "main", LIVE_VERSION);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusHandoff = useRef(false);

  const close = (returnFocusToComposer: boolean) => {
    focusHandoff.current = returnFocusToComposer;
    setOpen(false);
  };

  const insert = (upload: ChatUpload) => {
    close(true);
    if (upload.reference) insertIntoChatComposer(threadId, upload.reference, upload.fileKind);
  };

  // A deleted upload goes to Trash like a document: its row leaves the list at once, and Undo
  // shows in a notice.
  const remove = (upload: ChatUpload) => {
    deleteEntries([
      { ref: { kind: "file", id: upload.documentId }, name: upload.name, view: LIVE_VIEW },
    ]);
    // A gone file must not ride along on the message being written.
    removeFromChatComposer(threadId, upload.documentId);
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
          contentRef.current?.querySelector<HTMLElement>("[data-list-item]")?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (focusHandoff.current) event.preventDefault();
          focusHandoff.current = false;
        }}
        onKeyDown={handleListKeys}
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
              label={schemeLabel("uploads")}
              state={
                uploads.length === 0 ? (
                  <ListLine density="menu" iconSlot>
                    <Trans>No files attached in this chat yet.</Trans>
                  </ListLine>
                ) : null
              }
            >
              {uploads.map((upload) => (
                <UploadRow
                  key={upload.documentId}
                  upload={upload}
                  now={now}
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
  onInsert,
  onDelete,
}: {
  upload: ChatUpload;
  now: number;
  onInsert: () => void;
  onDelete: () => void;
}) {
  const Icon = iconFor(upload);
  const name = upload.name;
  const drag = useReferenceDrag({ ref: { kind: "file", id: upload.documentId }, name });
  return (
    <li>
      <ListRow
        density="menu"
        onOpen={onInsert}
        controlProps={{ ...drag, "aria-label": t`Add ${name} to your message` }}
        leading={<Icon aria-hidden className="text-muted-foreground" />}
        title={name}
        detail={uploadTypeLabel(upload.fileType)}
        meta={attachedAgo(upload.attachedAt, now)}
        actions={
          <IconButton size="xs" label={t`Delete ${name}`} onClick={onDelete} className="mr-1">
            <Trash2 aria-hidden />
          </IconButton>
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
    label: t`Files can't be dropped into Uploads`,
  }),
  drop: () => {},
};

const UPLOADS_TARGET = { scheme: "uploads", treeRootId: "uploads", folder: null } as const;

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
