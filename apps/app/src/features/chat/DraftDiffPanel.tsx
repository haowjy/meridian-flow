/** DraftDiffPanel — shared docked/modal diff review primitive for AI document drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown } from "@/rich-content/Markdown";

import { collapseDiffBlocks, type DiffBlock, diffLines } from "./diff-lines";
import type { DraftReviewController } from "./useDraftReviewController";

type ViewMode = "changes" | "preview";

export type DraftDiffPanelProps = {
  controller: DraftReviewController;
  documentId: string;
  draftId: string;
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  onKeepReading?: () => void;
};

export function DraftDiffPanel({
  controller,
  documentId,
  draftId,
  className,
  bodyClassName,
  footerClassName,
  onKeepReading,
}: DraftDiffPanelProps) {
  const { preview, isFetching, isError } = useDraftPreview(
    controller.threadId,
    documentId,
    draftId,
  );
  const [view, setView] = useState<ViewMode>("changes");
  const needsOverlapConfirm = controller.overlap?.draftId === draftId;

  useEffect(() => {
    if (needsOverlapConfirm) setView("preview");
  }, [needsOverlapConfirm]);

  const isPending = controller.isPending;
  const live = preview?.live ?? null;
  const previewMarkdown = preview?.status === "active" ? preview.preview : null;
  const liveRevisionToken = preview?.status === "active" ? preview.liveRevisionToken : null;
  const draftRevisionToken = preview?.status === "active" ? preview.draftRevisionToken : null;
  const staleMessage =
    controller.staleDraft?.draftId === draftId ? controller.staleDraftMessage : null;
  const reviewLive =
    controller.overlap?.draftId === draftId ? (controller.overlap.live ?? live) : live;
  const reviewPreview =
    controller.overlap?.draftId === draftId
      ? (controller.overlap.preview ?? previewMarkdown)
      : previewMarkdown;
  const reviewLiveRevisionToken =
    controller.overlap?.draftId === draftId
      ? (controller.overlap.liveRevisionToken ?? liveRevisionToken)
      : liveRevisionToken;

  function handleAccept() {
    if (isPending) return;
    controller.accept(documentId, draftId, {
      confirmedLiveRevisionToken: needsOverlapConfirm
        ? (reviewLiveRevisionToken ?? undefined)
        : undefined,
      draftRevisionToken: draftRevisionToken ?? undefined,
    });
  }

  function handleDiscard() {
    if (isPending) return;
    controller.reject(documentId, draftId);
  }

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} data-draft-diff-panel>
      <div className="flex items-center gap-1 border-border-subtle border-b px-4 py-2">
        <ViewToggle view={view} onChange={setView} />
      </div>

      {staleMessage ? (
        <div
          className="border-border-subtle border-b bg-surface-subtle px-4 py-3 text-sm text-foreground"
          role="alert"
        >
          {staleMessage}
        </div>
      ) : null}

      {needsOverlapConfirm ? (
        <div className="border-border-subtle border-b bg-surface-subtle px-4 py-3 text-sm text-foreground">
          <p className="font-medium">
            <Trans>Review the merged passage before applying.</Trans>
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            <Trans>The preview below includes your latest edits and the AI draft together.</Trans>
          </p>
        </div>
      ) : null}

      <main className={cn("prose-tokens overflow-y-auto px-4 py-4", bodyClassName)}>
        <PreviewBody
          view={view}
          live={reviewLive}
          previewMarkdown={reviewPreview}
          isFetching={isFetching}
          isError={isError}
        />
      </main>

      <footer
        className={cn(
          "flex flex-wrap items-center justify-end gap-2 border-border-subtle border-t bg-surface-subtle px-4 py-2",
          footerClassName,
        )}
      >
        <Button
          type="button"
          variant="ghost"
          onClick={handleDiscard}
          disabled={isPending}
          className="text-muted-foreground hover:text-foreground"
        >
          {controller.isRejecting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          <Trans>Discard draft</Trans>
        </Button>
        {onKeepReading ? (
          <Button type="button" variant="outline" onClick={onKeepReading} disabled={isPending}>
            <Trans>Keep reading</Trans>
          </Button>
        ) : null}
        <Button type="button" variant="default" onClick={handleAccept} disabled={isPending}>
          {controller.isAccepting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          <Trans>Apply to chapter</Trans>
        </Button>
      </footer>
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
  if (previewMarkdown == null && live == null && isFetching) {
    return (
      <StatusRow tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading draft…</Trans>
      </StatusRow>
    );
  }
  if (previewMarkdown == null) {
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
  const text = block.lines.join("\n");
  if (block.kind === "equal") {
    return <p className="whitespace-pre-wrap text-foreground/85">{text || " "}</p>;
  }
  if (block.kind === "added") {
    return (
      <p className="whitespace-pre-wrap rounded-md bg-chip-primary-bg px-2 py-1 text-foreground">
        <span className="sr-only">
          <Trans>Added:</Trans>{" "}
        </span>
        {text || " "}
      </p>
    );
  }
  return (
    <p className="whitespace-pre-wrap rounded-md bg-destructive-tint px-2 py-1 text-muted-foreground line-through decoration-muted-foreground/70">
      <span className="sr-only">
        <Trans>Removed:</Trans>{" "}
      </span>
      {text || " "}
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
