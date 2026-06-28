/**
 * Thread-info proto — sticky ⓘ popover with selectable document rows.
 * Disposable mock: proves non-blocking popover + active-doc surfacing by mode.
 */
import { Check, ChevronDown, FileText, Info, Pencil, Upload, X } from "lucide-react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type RailDocument, Section } from "@/features/chat/ThreadDocumentList";
import { cn } from "@/lib/utils";

import { MockChatHeaderChrome } from "./MockChatHeaderChrome";
import {
  ACTIVE_THREAD_ID,
  MOCK_RECENT_WRITES,
  MOCK_THREAD_TITLE,
  MOCK_UNGROUPED_THREADS,
  MOCK_UPLOADS,
  MOCK_WORK_GROUPS,
} from "./mock-data";
import { SelectableDocumentRow } from "./SelectableDocumentRow";

export type ViewerMode = "chat" | "context-viewer";

export function ThreadInfoDemo({ mode }: { mode: ViewerMode }) {
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const activeDoc = findDocument(activeDocId);

  return (
    <div className="flex min-h-[min(32rem,70svh)] w-full">
      {mode === "chat" && activeDoc ? <MockSidebar document={activeDoc} /> : null}
      {mode === "context-viewer" && activeDoc ? <MockMainViewer document={activeDoc} /> : null}

      <div
        className={cn(
          "flex min-w-0 flex-col",
          mode === "context-viewer"
            ? "w-full max-w-sm shrink-0 border-l border-border-subtle"
            : "flex-1",
        )}
      >
        <MockChatHeaderChrome
          titleControl={<ThreadSwitcherOnly />}
          extraActions={
            <ThreadContentsPopover
              activeDocId={activeDocId}
              onSelectDoc={(id) => setActiveDocId(id)}
            />
          }
        />

        <div className="flex min-h-0 flex-1 flex-col bg-surface-subtle">
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
            <MockMessage speaker="user">Can you tighten the pacing in chapter 3?</MockMessage>
            <MockMessage speaker="assistant">
              I read your upload and flagged three scenes where tension drops. Want me to sketch
              trims?
            </MockMessage>
          </div>

          <div className="shrink-0 border-t border-border-subtle bg-background p-3">
            <label className="sr-only" htmlFor="proto-composer">
              Message
            </label>
            <textarea
              id="proto-composer"
              rows={2}
              placeholder="Reply to Story Editor…"
              className="focus-ring w-full resize-none rounded-md border border-border-subtle bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThreadContentsPopover({
  activeDocId,
  onSelectDoc,
}: {
  activeDocId: string | null;
  onSelectDoc: (documentId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen} modal={false}>
      <PopoverTrigger
        type="button"
        aria-label="Thread contents"
        title="Thread contents"
        className="focus-ring grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground data-[state=open]:bg-sidebar-accent/60 data-[state=open]:text-foreground"
      >
        <Info className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 gap-0 p-0"
        onInteractOutside={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <h2 className="text-sm font-semibold text-foreground">Thread contents</h2>
          <button
            type="button"
            aria-label="Close thread contents"
            onClick={() => setOpen(false)}
            className="focus-ring grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[min(24rem,50svh)] overflow-y-auto p-2">
          <ThreadContentsBody activeDocId={activeDocId} onSelectDoc={onSelectDoc} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ThreadContentsBody({
  activeDocId,
  onSelectDoc,
}: {
  activeDocId: string | null;
  onSelectDoc: (documentId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Section
        title="Uploads"
        icon={<Upload className="size-3.5" />}
        count={MOCK_UPLOADS.length}
        defaultOpen
      >
        <ul className="flex flex-col">
          {MOCK_UPLOADS.map((doc) => (
            <SelectableDocumentRow
              key={doc.documentId}
              document={doc}
              active={doc.documentId === activeDocId}
              onSelect={() => onSelectDoc(doc.documentId)}
            />
          ))}
        </ul>
      </Section>
      <Section
        title="Recent writes"
        icon={<FileText className="size-3.5" />}
        count={MOCK_RECENT_WRITES.length}
        defaultOpen
      >
        <ul className="flex flex-col">
          {MOCK_RECENT_WRITES.map((doc) => (
            <SelectableDocumentRow
              key={doc.documentId}
              document={doc}
              active={doc.documentId === activeDocId}
              onSelect={() => onSelectDoc(doc.documentId)}
            />
          ))}
        </ul>
      </Section>
    </div>
  );
}

function ThreadSwitcherOnly() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        className="focus-ring -ml-1.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-sidebar-accent"
      >
        <span className="pane-title min-w-0 truncate">{MOCK_THREAD_TITLE}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
          <Pencil className="size-3.5" aria-hidden />
          Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-fine uppercase tracking-wide text-muted-foreground">
          Switch chat
        </DropdownMenuLabel>
        {MOCK_WORK_GROUPS.map((group) => (
          <div key={group.id}>
            <DropdownMenuLabel className="text-meta font-semibold uppercase tracking-label text-ink-subtle">
              {group.name}
            </DropdownMenuLabel>
            {group.threads.map((thread) => (
              <MockThreadItem
                key={thread.id}
                title={thread.title}
                active={thread.id === ACTIVE_THREAD_ID}
              />
            ))}
          </div>
        ))}
        {MOCK_UNGROUPED_THREADS.map((thread) => (
          <MockThreadItem
            key={thread.id}
            title={thread.title}
            active={thread.id === ACTIVE_THREAD_ID}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MockThreadItem({ title, active }: { title: string; active: boolean }) {
  return (
    <DropdownMenuItem
      onSelect={(e) => e.preventDefault()}
      className={cn(active && "bg-primary/10 font-medium text-foreground")}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {active ? <Check className="size-3.5 shrink-0 text-primary" aria-hidden /> : null}
    </DropdownMenuItem>
  );
}

function MockSidebar({ document }: { document: RailDocument }) {
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-sidebar">
      <div className="border-b border-border-subtle px-3 py-2">
        <p className="text-meta text-muted-foreground">Sidebar</p>
        <p className="truncate text-sm font-medium text-foreground">{document.name}</p>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-3 py-3">
        <p className="text-xs leading-relaxed text-ink-muted">Opened in sidebar</p>
        <p className="text-meta text-muted-foreground">
          {formatFileDetail(document.extension, document.sizeBytes)}
        </p>
      </div>
    </aside>
  );
}

function MockMainViewer({ document }: { document: RailDocument }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col border-r border-border-subtle bg-background">
      <div className="border-b border-border-subtle px-4 py-3">
        <p className="text-meta text-muted-foreground">Context viewer</p>
        <h2 className="truncate text-lg font-semibold text-foreground">{document.name}</h2>
      </div>
      <div className="flex flex-1 flex-col gap-3 px-4 py-4 text-sm leading-relaxed text-ink-muted">
        <p>
          Placeholder body for the active document. In production this is the full editor or
          preview.
        </p>
        <p>The chat column stays on the right while you read context here.</p>
      </div>
    </main>
  );
}

function MockMessage({ speaker, children }: { speaker: "user" | "assistant"; children: string }) {
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed",
        speaker === "user"
          ? "ml-auto bg-primary/10 text-foreground"
          : "mr-auto bg-card text-foreground shadow-sm",
      )}
    >
      {children}
    </div>
  );
}

function findDocument(documentId: string | null): RailDocument | null {
  if (!documentId) return null;
  return (
    [...MOCK_UPLOADS, ...MOCK_RECENT_WRITES].find((doc) => doc.documentId === documentId) ?? null
  );
}

function formatFileDetail(extension: string, sizeBytes: number | null): string {
  const ext = extension.replace(/^\./, "").toUpperCase();
  if (sizeBytes == null) return ext || "";
  const size = formatBytes(sizeBytes);
  return ext ? `${ext} · ${size}` : size;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
