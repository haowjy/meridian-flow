/** DraftDiffPanel — shared docked/modal diff review primitive for AI document drafts. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { CopyTextButton } from "@/components/app/CopyTextButton";
import { Badge } from "@/components/ui/badge";
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
  documentName?: string | null;
  className?: string;
  bodyClassName?: string;
  footerClassName?: string;
  /** Called when the writer explicitly closes the panel without accepting
   *  or discarding. Present when the panel renders in the docked/modal
   *  fallback where a Close button is separate from the review actions. */
  onClose?: () => void;
};

export function DraftDiffPanel({
  controller,
  documentId,
  draftId,
  documentName = null,
  className,
  bodyClassName,
  footerClassName,
  onClose,
}: DraftDiffPanelProps) {
  const { preview, isFetching, isError } = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    draftId,
  );
  const [view, setView] = useState<ViewMode>("changes");
  const needsOverlapConfirm = controller.overlap?.draftId === draftId;

  const changeCount =
    preview?.status === "active" && preview.inlineModelPresent ? preview.operations.length : null;

  useEffect(() => {
    if (needsOverlapConfirm) setView("preview");
  }, [needsOverlapConfirm]);

  const isPending = controller.isPending;
  const live = preview?.live ?? null;
  const previewMarkdown = preview?.status === "active" ? preview.preview : null;
  const liveRevisionToken = preview?.status === "active" ? preview.liveRevisionToken : null;
  const staleMessage =
    controller.staleDraft?.draftId === draftId ? controller.staleDraftMessage : null;
  const isCannotPlace = controller.cannotPlaceDraft?.draftId === draftId;
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
    });
  }

  function handleDiscard() {
    if (isPending) return;
    controller.reject(documentId, draftId);
  }

  return (
    <div className={cn("flex flex-col overflow-hidden", className)} data-draft-diff-panel>
      <header className="flex items-start justify-between gap-3 border-border-subtle border-b bg-card px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-foreground text-sm font-semibold">
            {changeCount != null && documentName ? (
              <Trans>
                {changeCount} changes proposed to{" "}
                <span className="font-medium">{documentName}</span>
              </Trans>
            ) : documentName ? (
              <Trans>
                Changes proposed to <span className="font-medium">{documentName}</span>
              </Trans>
            ) : (
              <Trans>Review AI draft</Trans>
            )}
          </h2>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="focus-ring grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface-subtle hover:text-foreground"
            aria-label={t`Close preview`}
          >
            <X className="size-4" aria-hidden />
          </button>
        ) : null}
      </header>
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

      {isCannotPlace ? (
        // Calm terminal banner — the neutral dead-card skin (DeadCardContent
        // in DraftReviewSidebar): neutral-ink pill carries "stuck", muted ink
        // carries the guidance. Deliberately hue-free — jade is the "do/go"
        // voice and red reads as danger; a stuck draft is neither. The banner
        // only explains; the footer carries the single recovery action (Copy)
        // beside Discard, so the copy affordance isn't buried here as well.
        <div
          className="flex items-start gap-2 border-border-subtle border-b bg-surface-subtle px-4 py-3"
          role="status"
        >
          <Badge variant="status" className="mt-0.5 shrink-0 bg-muted-foreground text-background">
            <Trans>Can't place</Trans>
          </Badge>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {previewMarkdown != null ? (
              <Trans>
                The document changed, so this draft can’t be placed automatically. Copy the text you
                need, or discard the draft.
              </Trans>
            ) : (
              <Trans>
                The document changed, so this draft can’t be placed automatically. Discard the
                draft.
              </Trans>
            )}
          </p>
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
        {/* Footer verbs in order: Close (dismiss, no state change), Discard
            (destructive, quiet), then the main affordance rightmost — Apply
            (primary) for a live draft, Copy (secondary) once placement failed
            terminally. No Apply in the terminal state: a permanently-disabled
            primary would read as "temporarily unavailable", and it isn't.
            Close is semantically the same as the header X on the modal — one
            dismissal pattern. */}
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground"
          >
            <Trans>Close preview</Trans>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={handleDiscard}
          disabled={isPending}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          {controller.isRejecting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : null}
          <Trans>Discard draft</Trans>
        </Button>
        {isCannotPlace ? (
          previewMarkdown != null ? (
            <CopyTextButton text={previewMarkdown} variant="secondary">
              <Trans>Copy draft</Trans>
            </CopyTextButton>
          ) : null
        ) : (
          <Button type="button" variant="default" onClick={handleAccept} disabled={isPending}>
            {controller.isAccepting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : null}
            <Trans>Apply draft</Trans>
          </Button>
        )}
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
