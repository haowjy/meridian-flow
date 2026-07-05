/**
 * DockChangesView — the dock's work-scoped Changes view (query/group shell).
 *
 * Lists every document with pending AI changes for the Work, one row each:
 * name + `+N −N` word totals + a hover-revealed Review verb. Whole-row click
 * is Review, routed through the SAME launcher the composer DraftDock uses
 * (`useAiDraftLauncher`), so opening review and switching the dock to Changes
 * stay one gesture with one code path.
 *
 * The document CURRENTLY under inline review expands to operation cards
 * (`ReviewOperationCard`) read from the live preview (`useDraftPreview`). This
 * module orchestrates: it fetches the preview, builds the inline-review model
 * once, renders the card list, and renders the single session message line.
 * The card + verb rendering lives in `ReviewOperationCard`; the card-body text
 * extraction lives in `operation-change-text`.
 */
import { Trans } from "@lingui/react/macro";
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { useMemo, useState } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { type DockRow, dockRows } from "@/features/chat/docked-drafts";
import { DraftStatsLabel, draftStats } from "@/features/chat/draft-stats";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";
import type {
  DraftReviewController,
  InlineReviewMessageCode,
} from "@/features/chat/useDraftReviewController";
import { cn } from "@/lib/utils";
import { operationChangeText } from "./operation-change-text";
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
  const name = row.documentName ?? row.documentId;
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
        />
      ) : null}
    </div>
  );
}

/**
 * Operation cards for the document under review. Local active state is the
 * click echo — clicking a card body scrolls the manuscript and rings the card;
 * the editor is the source of truth for the span, this is just the index into
 * it. One card per operation the preview hands us — combining dependent regions
 * into a unit is upstream, this view never merges or splits.
 *
 * The inline-review model (anchors decoded) is built once here and threaded to
 * every card's Apply, which needs the operation's accept-closure ids and the
 * live revision token the accept confirms against.
 */
function ReviewOperationCards({
  preview,
  controller,
  draftId,
}: {
  preview: ActivePreview;
  controller: DraftReviewController;
  draftId: string;
}) {
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
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
  // One review session runs one accept/discard message at a time, so a single
  // quiet line under the cards is enough — no per-card message plumbing.
  const message = currentReviewMessage(controller);
  return (
    <div className="flex flex-col gap-1.5 pb-1.5 pl-2">
      {preview.operations.map((operation) => (
        <ReviewOperationCard
          key={operation.operationId}
          operation={operation}
          model={model}
          controller={controller}
          draftId={draftId}
          change={operationChangeText(operation, preview.hunks)}
          active={activeOperationId === operation.operationId}
          onFocus={() => {
            setActiveOperationId(operation.operationId);
            controller.focusReviewOperation(operation.operationId);
          }}
        />
      ))}
      {message ? (
        <p
          className={cn(
            "px-1 text-caption",
            message.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
          role={message.tone === "error" ? "alert" : undefined}
        >
          <ReviewMessageText code={message.code} />
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
): { code: InlineReviewMessageCode; tone: "info" | "error" } | null {
  if (controller.inlineReviewMessage) {
    return {
      code: controller.inlineReviewMessage.code,
      tone: controller.inlineReviewMessage.tone ?? "info",
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
  }
}
