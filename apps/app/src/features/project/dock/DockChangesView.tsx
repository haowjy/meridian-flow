/**
 * DockChangesView — the dock's work-scoped Changes view (query/group shell).
 *
 * Lists every document with pending AI changes for the Work, one row each:
 * name + `+N −N` word totals + a hover-revealed Review verb. Whole-row click
 * is Review, routed through the SAME launcher the composer DraftDock uses
 * (`useAiDraftLauncher`), so opening review and switching the dock to Changes
 * stay one gesture with one code path.
 *
 * The document CURRENTLY under inline review expands to proposal cards read
 * from the live preview (`useDraftPreview`): the flat operation list is
 * partitioned into closure classes (`partitionClosureClasses`), one card per
 * class (spec §5.3). This module orchestrates: it fetches the preview, builds
 * the inline-review model once, partitions the classes, renders the card list,
 * and renders the single session message line. The card + verb rendering lives
 * in `ReviewOperationCard`; the closure partition + card-body text extraction
 * live in `closure-classes` / `operation-change-text`.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { useMemo, useState } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { NewBadge } from "@/components/app/NewBadge";
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows, documentBasename } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import type {
  DraftReviewController,
  InlineReviewMessageCode,
} from "@/features/chat/useDraftReviewController";
import { cn } from "@/lib/utils";
import { partitionClosureClasses } from "./closure-classes";
import { ReviewOperationCard } from "./ReviewOperationCard";

export function DockChangesView({ className }: { className?: string }) {
  const { groups, nowMs, controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  const rows = useMemo(
    () => dockRows(groups, nowMs).filter((row) => row.state === "pending"),
    [groups, nowMs],
  );

  const inlineReview = controller.inlineReview;
  const preview = useDraftPreview(
    controller.projectId,
    controller.workId,
    inlineReview?.documentId ?? null,
    inlineReview?.draftId ?? null,
    { enabled: Boolean(inlineReview) },
  );
  const activePreview =
    preview.preview?.status === "active" && preview.preview.inlineModelPresent
      ? preview.preview
      : null;

  return (
    <div className={cn("flex min-h-0 flex-col overflow-y-auto px-2 py-2", className)}>
      {rows.length === 0 ? (
        <p className="px-2 py-1.5 text-caption text-muted-foreground">
          <Trans>No pending changes.</Trans>
        </p>
      ) : (
        rows.map((row) => (
          <ChangesDocumentGroup
            key={row.documentId}
            row={row}
            controller={controller}
            active={row.documentId === inlineReview?.documentId}
            preview={row.documentId === inlineReview?.documentId ? activePreview : null}
            onReview={() =>
              openAiDraft(
                {
                  documentId: row.documentId,
                  contextPath: row.contextPath ?? undefined,
                  documentName: row.documentName ?? undefined,
                },
                row.draft.draftId,
              )
            }
          />
        ))
      )}
    </div>
  );
}

type ActivePreview = {
  operations: ReviewOperation[];
  hunks: ReviewHunk[];
  liveRevisionToken: number;
  draftRevisionToken: number;
  // server preview flag for a draft-created document (spec §5.5).
  isNewDocument?: boolean;
};

/**
 * One document group: the header row Reviews it (the lane's whole-row target
 * grammar). When this document is under review, its operations render as change
 * cards beneath the header.
 *
 * Rail grammar throughout (matches ContextSidebar's DocumentRow): transparent
 * rows, `text-sm` names, `text-caption` secondary in the muted-foreground ramp,
 * `sidebar-accent` tints. The stats label sizes itself from context, so the
 * caption wrapper here is what keeps `+2,033` quieter than the document name.
 */
function ChangesDocumentGroup({
  row,
  controller,
  active,
  preview,
  onReview,
}: {
  row: DockRow;
  controller: DraftReviewController;
  active: boolean;
  preview: ActivePreview | null;
  onReview: () => void;
}) {
  // New docs are URI-addressed: fall back to the path basename when the AI
  // created the document unnamed, then to a defensive "Untitled document"
  // (spec §5.5, product call 2026-07-05).
  const name =
    row.documentName ??
    (row.isNewDocument
      ? (documentBasename(row.contextPath) ?? t`Untitled document`)
      : row.documentId);
  const stats = draftStats(row.draft);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onReview}
        className={cn(
          "group focus-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          active ? "bg-sidebar-accent/50" : "hover:bg-sidebar-accent/40",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
        {/* The one signal that differentiates a new-document row from an edited
            one — a quiet neutral badge between the name and the stats. Its
            additions-only stats (`+N`, no `−0`) reinforce it (spec §5.5). */}
        {row.isNewDocument ? <NewBadge /> : null}
        {stats ? (
          <span className="shrink-0 text-caption">
            <DraftStatsLabel stats={stats} wordsSuffix={false} />
          </span>
        ) : null}
        {/* The doc under review has no Review left to offer — the verb only
            appears on rows where it still does something. */}
        {!active ? (
          <span className="shrink-0 text-caption font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <Trans>Review</Trans>
          </span>
        ) : null}
      </button>
      {preview && preview.operations.length > 0 ? (
        <ReviewOperationCards
          preview={preview}
          controller={controller}
          draftId={row.draft.draftId}
          isNewDocument={row.isNewDocument || preview.isNewDocument === true}
        />
      ) : null}
    </div>
  );
}

/**
 * Proposal cards for the document under review (spec §5.3, closure=card). The
 * flat operation list is partitioned into closure classes here — causal drag ∪
 * hunk-sharing — and each class renders as ONE card. Local active state is the
 * click echo, keyed by class: clicking a card body scrolls the manuscript and
 * rings the card; the editor is the source of truth for the span.
 *
 * The inline-review model (anchors decoded) is built once here and threaded to
 * every card's Apply, which needs the representative operation's accept-closure
 * ids and the live revision token the accept confirms against.
 */
function ReviewOperationCards({
  preview,
  controller,
  draftId,
  isNewDocument,
}: {
  preview: ActivePreview;
  controller: DraftReviewController;
  draftId: string;
  isNewDocument: boolean;
}) {
  const [activeClassId, setActiveClassId] = useState<string | null>(null);
  const model = useMemo(
    () =>
      buildInlineReviewModel({
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
        operations: preview.operations,
        hunks: preview.hunks,
      }),
    [preview],
  );
  const proposals = useMemo(
    () => partitionClosureClasses(preview.operations, preview.hunks),
    [preview],
  );
  // One review session runs one accept/discard message at a time, so a single
  // quiet line under the cards is enough — no per-card message plumbing.
  const message = currentReviewMessage(controller);
  return (
    <div className="flex flex-col gap-1.5 pb-1.5 pl-2">
      {proposals.map((proposal) => (
        <ReviewOperationCard
          key={proposal.classId}
          proposal={proposal}
          model={model}
          controller={controller}
          draftId={draftId}
          isNewDocument={isNewDocument}
          active={activeClassId === proposal.classId}
          onFocus={() => {
            setActiveClassId(proposal.classId);
            // Focus the class's representative op; the editor emphasizes its
            // hunks. (Whole-class emphasis for multi-op classes needs multi-op
            // focus — tracked as an S4-merge follow-up.)
            controller.focusReviewOperation(proposal.primaryOperation.operationId);
          }}
        />
      ))}
      {message ? (
        <p
          className={cn(
            "flex items-center gap-2 px-1 text-caption",
            message.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={message.tone === "error" ? "alert" : undefined}
        >
          <ReviewMessageText code={message.code} />
          {/* A per-card Apply is reversible while its "Change applied" receipt
              stands; the write id rides the message. */}
          {message.writeId ? (
            <button
              type="button"
              onClick={() => controller.undoAcceptOperation()}
              disabled={controller.isDisposing}
              className="focus-ring shrink-0 rounded-sm font-medium text-primary disabled:opacity-50"
            >
              <Trans>Undo</Trans>
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The one active review message, resolved from the controller's coded state:
 * an accept message when present, otherwise a discard error. The controller
 * emits only codes (it is a state machine with no writer-facing strings); the
 * copy is localized here.
 */
function currentReviewMessage(
  controller: DraftReviewController,
): { code: InlineReviewMessageCode; tone: "info" | "error"; writeId?: string } | null {
  if (controller.inlineReviewMessage) {
    return {
      code: controller.inlineReviewMessage.code,
      tone: controller.inlineReviewMessage.tone ?? "info",
      writeId: controller.inlineReviewMessage.writeId,
    };
  }
  if (controller.inlineDiscardError) {
    return { code: controller.inlineDiscardError, tone: "error" };
  }
  return null;
}

/** Localized copy for each controller message code. */
function ReviewMessageText({ code }: { code: InlineReviewMessageCode }) {
  switch (code) {
    case "open-review-first":
      return <Trans>Open the latest review before applying a change.</Trans>;
    case "change-moved":
      return <Trans>That change moved. Refreshed to the latest changes.</Trans>;
    case "apply-failed":
      return <Trans>Couldn't apply. Check your connection and try again.</Trans>;
    case "change-applied":
      return <Trans>Change applied.</Trans>;
    case "changes-moved-refreshed":
      return <Trans>The changes moved on. Refreshed the list.</Trans>;
    case "apply-dependencies-first":
      return (
        <Trans>
          This change builds on earlier AI changes. Apply those first, or use Apply all.
        </Trans>
      );
    case "change-cannot-place":
      return <Trans>A change no longer lines up with the manuscript.</Trans>;
    case "changes-moved-confirm-again":
      return <Trans>The changes moved on. Review the related changes and confirm again.</Trans>;
    case "draft-cannot-place":
      return (
        <Trans>
          The draft no longer lines up with the manuscript. Discard it or ask for a fresh revision.
        </Trans>
      );
    case "discard-stale":
      return <Trans>Couldn't discard. Your latest edits are still syncing, try again soon.</Trans>;
    case "discard-finalized":
      return <Trans>Couldn't discard. This draft may already be applied or discarded.</Trans>;
    case "discard-offline":
      return <Trans>Couldn't discard. Check your connection and try again.</Trans>;
    case "discard-failed":
      return <Trans>Couldn't discard. Try again.</Trans>;
    case "discard-not-settled":
      return <Trans>That change is still in the draft. Try again before applying the draft.</Trans>;
    case "change-restored":
      return <Trans>Change restored.</Trans>;
    case "undo-failed":
      return <Trans>Couldn't undo that change. Nothing happened.</Trans>;
  }
}
