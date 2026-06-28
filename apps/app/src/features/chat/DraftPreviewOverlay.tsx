/**
 * DraftPreviewOverlay — modal review surface for one document's active AI
 * draft. Opened from `DraftReviewCard` (and the unanchored fallback strip).
 *
 * Reuses the dialog/dock chrome pattern from `ResultViewerOverlay`: fixed
 * backdrop, dismissable via Escape or backdrop click, single panel frame.
 *
 * Renders strictly from API markdown (`useDraftPreview`). The live Yjs editor
 * is NEVER touched here — this surface is read-only on both sides. Only the
 * accept mutation eventually mutates the live document, and that happens on
 * the server.
 *
 * Two views:
 *  - "Show changes" — line-level prose diff (added emphasised, removed
 *    de-emphasised + struck), readable as prose not code.
 *  - "Clean preview" — the draft markdown rendered as final prose so the
 *    writer can read it without diff chrome before accepting.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";
import { Button } from "@/components/ui/button";
import { useEscapeToClose } from "@/features/project/shell/ResultViewerOverlay";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";
import { collapseDiffBlocks, type DiffBlock, diffLines } from "./diff-lines";

export type DraftPreviewOverlayProps = {
  threadId: string;
  documentId: string;
  documentName: string | null;
  onClose: () => void;
};

type ViewMode = "changes" | "preview";

export function DraftPreviewOverlay({
  threadId,
  documentId,
  documentName,
  onClose,
}: DraftPreviewOverlayProps) {
  useEscapeToClose(onClose);
  const accept = useAcceptDraft();
  const reject = useRejectDraft();
  const { live, previewMarkdown, isFetching, isError } = useDraftPreview(threadId, documentId);
  const [view, setView] = useState<ViewMode>("changes");

  const isPending = accept.isPending || reject.isPending;
  const heading = documentName ?? t`Document draft`;

  function handleAccept() {
    if (isPending) return;
    accept.mutate({ threadId, documentId }, { onSuccess: onClose });
  }

  function handleDiscard() {
    if (isPending) return;
    reject.mutate({ threadId, documentId }, { onSuccess: onClose });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t`Review AI draft`}
    >
      <button
        type="button"
        aria-label={t`Close`}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div className="relative flex h-[min(90vh,900px)] w-[min(96vw,1100px)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
        <header className="flex items-start justify-between gap-3 border-border-subtle border-b px-5 py-3">
          <div className="min-w-0">
            <p className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
              <Trans>AI draft</Trans>
            </p>
            <h2 className="mt-0.5 truncate text-foreground text-base font-medium">{heading}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Trans>Your live document is untouched until you accept.</Trans>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring grid size-7 shrink-0 place-items-center rounded-md border border-border-subtle bg-card text-muted-foreground hover:text-foreground"
            aria-label={t`Close`}
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex items-center gap-1 border-border-subtle border-b px-5 py-2">
          <ViewToggle view={view} onChange={setView} />
        </div>

        <main className="prose-tokens min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <PreviewBody
            view={view}
            live={live}
            previewMarkdown={previewMarkdown}
            isFetching={isFetching}
            isError={isError}
          />
        </main>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-border-subtle border-t bg-surface-subtle px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            onClick={handleDiscard}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground"
          >
            {reject.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            <Trans>Discard draft</Trans>
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
            <Trans>Keep reading</Trans>
          </Button>
          <Button type="button" variant="default" onClick={handleAccept} disabled={isPending}>
            {accept.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            <Trans>Accept changes</Trans>
          </Button>
        </footer>
      </div>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (next: ViewMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label={t`Preview view`}
      className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-surface-subtle p-0.5"
    >
      <ToggleButton active={view === "changes"} onClick={() => onChange("changes")}>
        <Trans>Show changes</Trans>
      </ToggleButton>
      <ToggleButton active={view === "preview"} onClick={() => onChange("preview")}>
        <Trans>Clean preview</Trans>
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "focus-ring rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-card text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PreviewBody({
  view,
  live,
  previewMarkdown,
  isFetching,
  isError,
}: {
  view: ViewMode;
  live: string | null;
  previewMarkdown: string | null;
  isFetching: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <StatusRow tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't load this draft.</Trans>
      </StatusRow>
    );
  }
  // `previewMarkdown` is omitted when there is no active draft — usually
  // because the writer just accepted or discarded it. Render a soft empty
  // state instead of nothing; the overlay closes automatically on a
  // successful mutation.
  if (!previewMarkdown && !live && isFetching) {
    return (
      <StatusRow tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading draft…</Trans>
      </StatusRow>
    );
  }
  if (!previewMarkdown) {
    return (
      <StatusRow tone="muted">
        <Trans>This draft is no longer active.</Trans>
      </StatusRow>
    );
  }

  if (view === "preview") {
    return <Markdown variant="answer">{previewMarkdown}</Markdown>;
  }
  return <DiffView live={live ?? ""} previewMarkdown={previewMarkdown} />;
}

function DiffView({ live, previewMarkdown }: { live: string; previewMarkdown: string }) {
  // Heavy diff inputs would freeze the UI; if the LCS table would exceed our
  // budget the helper returns null and we degrade to the clean preview.
  const blocks = useMemo<DiffBlock[] | null>(() => {
    const ops = diffLines(live, previewMarkdown);
    return ops ? collapseDiffBlocks(ops) : null;
  }, [live, previewMarkdown]);

  if (!blocks) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          <Trans>This change is too large to highlight inline — showing the clean preview.</Trans>
        </p>
        <Markdown variant="answer">{previewMarkdown}</Markdown>
      </div>
    );
  }

  // If nothing actually changed, surface that honestly rather than rendering
  // a wall of "equal" prose with no signal.
  const hasChange = blocks.some((block) => block.kind !== "equal");
  if (!hasChange) {
    return (
      <StatusRow tone="muted">
        <Trans>No changes against the live document.</Trans>
      </StatusRow>
    );
  }

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block, idx) => (
        <DiffBlockView
          key={`${block.kind}-${idx}-${block.lines[0]?.slice(0, 32) ?? ""}`}
          block={block}
        />
      ))}
    </div>
  );
}

function DiffBlockView({ block }: { block: DiffBlock }) {
  // Each block is a contiguous run of one diff kind. Render as a paragraph so
  // prose reads naturally; line breaks within a block become real breaks.
  const text = block.lines.join("\n");
  if (block.kind === "equal") {
    return <p className="whitespace-pre-wrap text-foreground/85">{text || " "}</p>;
  }
  if (block.kind === "added") {
    return (
      <p className="whitespace-pre-wrap rounded-md bg-chip-primary-bg px-2 py-1 text-foreground">
        <span className="sr-only">
          <Trans>Added:</Trans>{" "}
        </span>
        {text || " "}
      </p>
    );
  }
  return (
    <p className="whitespace-pre-wrap rounded-md bg-destructive-tint px-2 py-1 text-muted-foreground line-through decoration-muted-foreground/70">
      <span className="sr-only">
        <Trans>Removed:</Trans>{" "}
      </span>
      {text || " "}
    </p>
  );
}

function StatusRow({ children, tone }: { children: React.ReactNode; tone: "muted" | "error" }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
