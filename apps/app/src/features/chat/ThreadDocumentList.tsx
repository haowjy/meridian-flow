/**
 * ThreadDocumentList — the shared display primitives for thread-scoped document
 * lists (uploads, recent writes). Collapsible section header with an honest
 * count, the five-state list body (disabled/loading/empty/ready/error), and the
 * per-document row visuals.
 *
 * These are the *content* of the thread context surface, independent of the
 * *container* that hosts them. Today both the `ContextSidebar` rail and the
 * `ThreadInfoSheet` peek render the same sections — sourcing/timestamp
 * differences live in the data layer, not here. (When the rail is replaced by
 * the context dock, these primitives stay.)
 */
import { Trans } from "@lingui/react/macro";
import type { DocumentFileType } from "@meridian/contracts/protocol";
import { AlertCircle, ChevronDown, FileText, Image as ImageIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ListQueryStatus } from "@/client/query/list-query";
import { cn } from "@/lib/utils";

/* ── Shared row contract ──────────────────────────────────────────────
 *
 * Both `ThreadUploadDocumentItem` and `ThreadRecentDocumentItem` carry the
 * same display fields (`documentId`, `name`, `extension`, `sizeBytes`,
 * `editable`/`fileType`). One `DocumentRow` renders both.
 */
export type RailDocument = {
  documentId: string;
  name: string;
  extension: string;
  sizeBytes: number | null;
  editable: boolean;
  fileType: DocumentFileType | null;
};

export type RailMessages = {
  /** Section is disabled (no thread selected, etc.). */
  disabled: string;
  /** Query is loading for the first time. */
  loading: string;
  /** Query resolved with zero rows. */
  empty: string;
  /** Query errored — surfaced alongside a Retry affordance. */
  error: string;
};

/**
 * One state-machine for a live document list. Renders the section header
 * (with a count visible **only** in `empty`/`ready` so we never fabricate a
 * `0` next to a "couldn't load" hint) and dispatches the body across the
 * five honest states.
 */
export function DocumentRailSection({
  title,
  icon,
  defaultOpen = false,
  status,
  rows,
  messages,
}: {
  title: string;
  icon: ReactNode;
  defaultOpen?: boolean;
  status: ListQueryStatus<RailDocument>;
  rows: RailDocument[] | null;
  messages: RailMessages;
}) {
  // Count is honest: it only exists in the loaded states. Anything else
  // (disabled, loading, error) hides the count entirely.
  const count = status.status === "ready" || status.status === "empty" ? (rows?.length ?? 0) : null;

  return (
    <Section title={title} icon={icon} count={count} defaultOpen={defaultOpen}>
      {status.status === "disabled" ? (
        <EmptyHint>{messages.disabled}</EmptyHint>
      ) : status.status === "loading" ? (
        <EmptyHint>{messages.loading}</EmptyHint>
      ) : status.status === "error" ? (
        <ErrorRow onRetry={status.refetch} label={messages.error} />
      ) : status.status === "empty" || rows == null || rows.length === 0 ? (
        <EmptyHint>{messages.empty}</EmptyHint>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <DocumentRow key={row.documentId} document={row} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DocumentRow({ document }: { document: RailDocument }) {
  return (
    <li>
      <div
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
        title={document.name}
      >
        <KindIcon fileType={document.fileType} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-foreground">{document.name}</span>
          <span className="truncate text-meta text-muted-foreground">
            {formatFileDetail(document.extension, document.sizeBytes)}
          </span>
        </span>
      </div>
    </li>
  );
}

export function Section({
  title,
  icon,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** `null` hides the count (loading, error, disabled); a number renders tabular. */
  count: number | null;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((p) => !p)}
        className="focus-ring flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-foreground transition-colors hover:bg-sidebar-accent"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="text-muted-foreground">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {count != null ? (
          <span className="shrink-0 text-meta tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </button>
      {open ? <div className="flex flex-col gap-0.5 pb-1 pl-2">{children}</div> : null}
    </section>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs leading-snug text-ink-subtle">{children}</p>;
}

function ErrorRow({ onRetry, label }: { onRetry: () => void; label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <AlertCircle className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{label}</span>
      <button
        type="button"
        onClick={onRetry}
        className="focus-ring shrink-0 rounded text-xs font-medium text-primary underline-offset-2 hover:underline"
      >
        <Trans>Retry</Trans>
      </button>
    </div>
  );
}

function KindIcon({ fileType }: { fileType: DocumentFileType | null }) {
  const { Icon, tone } = pickIcon(fileType);
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border border-border-subtle bg-surface-subtle",
        tone,
      )}
      aria-hidden
    >
      <Icon className="size-3.5" />
    </span>
  );
}

function pickIcon(fileType: DocumentFileType | null): { Icon: typeof FileText; tone: string } {
  switch (fileType) {
    case null:
      return { Icon: FileText, tone: "text-primary" };
    case "image":
      return { Icon: ImageIcon, tone: "text-status-streaming" };
    case "pdf":
      return { Icon: FileText, tone: "text-destructive" };
    case "docx":
      return { Icon: FileText, tone: "text-accent" };
    case "binary":
      return { Icon: FileText, tone: "text-muted-foreground" };
  }
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
