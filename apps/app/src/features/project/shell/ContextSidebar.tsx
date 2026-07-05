/**
 * ContextSidebar — right-side project rail summarizing work context sections
 * and deferred artifact surfaces. It is visual chrome only; data ownership
 * stays with the project/context feature hooks.
 */
import { t } from "@lingui/core/macro";
import type { DocumentFileType } from "@meridian/contracts/protocol";
import { FileText, Image as ImageIcon, Sparkles, Upload } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ProjectResultItem } from "@/client/api/project-results-api";
import type { ListQueryStatus } from "@/client/query/list-query";
import { useThreadRecentDocuments } from "@/client/query/useThreadRecentDocuments";
import { useThreadUploads } from "@/client/query/useThreadUploads";
import { DockShell } from "../dock/DockShell";
import { CollapsibleRailSection, RailEmptyHint, RailErrorRow, RailKindIcon } from "./RailSection";

import { ResultsRailBody, useResultsRailModel } from "./ResultsRailSection";
import { ResultViewerOverlay } from "./ResultViewerOverlay";

/**
 * Thread-context rail (Chat destination, right edge).
 *
 * Three sections, labels locked by the project design brief:
 *
 *   1. **Uploads** — files the user uploaded into this chat
 *      (`thread_documents`, the `.uploads` namespace).
 *   2. **Recent**  — documents the agent recently read/touched
 *      (`turn_document_touches`, deduped by document).
 *   3. **Results** — promoted artifacts the agent produced (project-scoped,
 *      not thread-scoped). Owns its own state machine in `ResultsRailSection`
 *      and reuses the existing read-only viewers in a modal overlay.
 *
 * Both live document sections share one `DocumentRailSection` primitive
 * that owns the loading/empty/error/disabled state machine and the count
 * suppression rules. Counts only render in `empty`/`ready` — anything else
 * (disabled, loading, error) hides the count so we never fabricate `0`
 * over the top of a hint that says "couldn't load". The Results section
 * mirrors the same honest count discipline.
 */
export type ContextSidebarProps = {
  /** Active thread; when null, sections render their disabled empty state. */
  threadId: string | null;
  /** Active project; powers the Results section (project-scoped, not thread-scoped). */
  projectId: string | null;
  onClose: () => void;
};

export function ContextSidebar({ threadId, projectId, onClose }: ContextSidebarProps) {
  const uploads = useThreadUploads(threadId);
  const recent = useThreadRecentDocuments(threadId);
  // Results live at the project scope (artifact persistence outlives any
  // single chat), so the rail tracks `projectId` independently of the
  // thread state. Open-result is local state — at most one viewer at a time.
  const [openResult, setOpenResult] = useState<ProjectResultItem | null>(null);
  const results = useResultsRailModel(projectId);

  return (
    <aside aria-label={t`Thread context`} className="flex h-full min-h-0 w-full flex-col">
      <DockShell placement="dock" screen="chat" onClose={onClose}>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-2">
          <DocumentRailSection
            title={t`Uploads`}
            icon={<Upload className="size-3.5" />}
            defaultOpen
            status={uploads}
            rows={uploads.uploads}
            messages={{
              disabled: t`Open a chat to see its uploads.`,
              loading: t`Loading uploads…`,
              empty: t`No files uploaded yet.`,
              error: t`Couldn't load uploads.`,
            }}
          />
          <DocumentRailSection
            title={t`Recent`}
            icon={<FileText className="size-3.5" />}
            status={recent}
            rows={recent.documents}
            messages={{
              disabled: t`Open a chat to see what the AI referenced.`,
              loading: t`Loading recent documents…`,
              empty: t`Documents the AI reads in this chat appear here.`,
              error: t`Couldn't load recent documents.`,
            }}
          />
          <CollapsibleRailSection
            title={t`Results`}
            icon={<Sparkles className="size-3.5" />}
            count={results.count}
            defaultOpen
          >
            <ResultsRailBody projectId={projectId} model={results} onOpenResult={setOpenResult} />
          </CollapsibleRailSection>
        </div>
      </DockShell>
      {openResult && projectId ? (
        <ResultViewerOverlay
          projectId={projectId}
          result={openResult}
          onClose={() => setOpenResult(null)}
        />
      ) : null}
    </aside>
  );
}

/* ── Shared row contract ──────────────────────────────────────────────
 *
 * Both `ThreadUploadDocumentItem` and `ThreadRecentDocumentItem` carry the
 * same display fields (`documentId`, `name`, `extension`, `sizeBytes`,
 * `editable`/`fileType`). One `DocumentRow` renders both — sourcing/timestamp
 * differences belong to the data layer, not the row visuals.
 */
type RailDocument = {
  documentId: string;
  name: string;
  extension: string;
  sizeBytes: number | null;
  editable: boolean;
  fileType: DocumentFileType | null;
};

/* ── Section primitives ──────────────────────────────────────────────── */

type RailMessages = {
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
 * One state-machine for both live data rails. Renders the section header
 * (with a count visible **only** in `empty`/`ready` so we never fabricate a
 * `0` next to a "couldn't load" hint) and dispatches the body across the
 * five honest states.
 */
function DocumentRailSection({
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
    <CollapsibleRailSection title={title} icon={icon} count={count} defaultOpen={defaultOpen}>
      {status.status === "disabled" ? (
        <RailEmptyHint>{messages.disabled}</RailEmptyHint>
      ) : status.status === "loading" ? (
        <RailEmptyHint>{messages.loading}</RailEmptyHint>
      ) : status.status === "error" ? (
        <RailErrorRow onRetry={status.refetch} label={messages.error} />
      ) : status.status === "empty" || rows == null || rows.length === 0 ? (
        <RailEmptyHint>{messages.empty}</RailEmptyHint>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <DocumentRow key={row.documentId} document={row} />
          ))}
        </ul>
      )}
    </CollapsibleRailSection>
  );
}

function DocumentRow({ document }: { document: RailDocument }) {
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

function KindIcon({ fileType }: { fileType: DocumentFileType | null }) {
  const { Icon, tone } = pickIcon(fileType);
  return (
    <RailKindIcon tone={tone}>
      <Icon className="size-3.5" />
    </RailKindIcon>
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
