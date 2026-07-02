/**
 * DraftReviewSidebar — proposal cards for inline draft review.
 *
 * The sidebar reads the inline-review plugin state (operations + hunks +
 * active operation), sorts operations into document order, and renders one
 * card per operation with attribution badge and Discard button. Clicking a
 * card emphasises the matching hunks in the editor and scrolls the editor to
 * them; clicking a highlighted region in the editor promotes that
 * operation's card and scrolls it into view here.
 *
 * Rejecting an operation is stubbed for this phase — the callback records a
 * "pending discard" locally so the button reads as busy, but the actual
 * client-side reject (reversing the operation's Yjs updates on the draft)
 * lands next phase. Per-operation reject lives in the controller so the
 * DraftReviewBar's whole-draft Apply/Discard buttons keep their own state.
 */
import { Trans } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  getInlineReviewPluginState,
  type InlineReviewPluginState,
} from "@/core/editor/extensions/inline-review";
import { cn } from "@/lib/utils";

import {
  type HunkPositionRange,
  type OrderedOperation,
  orderOperationsForSidebar,
} from "./inline-review-sidebar-order";

export type DraftReviewSidebarProps = {
  editor: Editor | null;
  className?: string;
  /**
   * Optional handler for the per-operation Discard button. Called when the
   * writer confirms they want to reject a single operation. The controller
   * is expected to run `reconstructInverse` on the draft's update rows and
   * apply the inverse Yjs update — that plumbing lands in the next phase.
   * Until then the sidebar surfaces a pending state locally and reports
   * back via this callback so tests + telemetry can observe intent.
   */
  onDiscardOperation?: (operationId: string) => Promise<void> | void;
};

interface SidebarSnapshot {
  pluginState: InlineReviewPluginState | null;
  entries: OrderedOperation[];
}

const EMPTY_SNAPSHOT: SidebarSnapshot = { pluginState: null, entries: [] };

export function DraftReviewSidebar({
  editor,
  className,
  onDiscardOperation,
}: DraftReviewSidebarProps) {
  // Local "pending discard" set: buttons stay busy until the caller resolves.
  // The next phase will replace this with the real reject controller — that
  // controller will own success/failure state; this only exists so the button
  // doesn't fire twice and the writer sees a spinner while we wire the real
  // path. See TODO(draft-reject-phase) below.
  const [pendingDiscardIds, setPendingDiscardIds] = useState<ReadonlySet<string>>(() => new Set());

  const snapshot =
    useEditorState<SidebarSnapshot>({
      editor,
      selector: ({ editor: currentEditor }) => {
        if (!currentEditor) return EMPTY_SNAPSHOT;
        const pluginState = getInlineReviewPluginState(currentEditor.state);
        if (!pluginState?.model) {
          return { pluginState, entries: [] };
        }
        const model = pluginState.model;
        const positions = collectHunkPositions(pluginState);
        const entries = orderOperationsForSidebar(model.operations, model.hunks, positions);
        return { pluginState, entries };
      },
      equalityFn: (a, b) => {
        if (a === b) return true;
        if (!a || !b) return false;
        return sidebarSnapshotEqual(a, b);
      },
    }) ?? EMPTY_SNAPSHOT;

  const { pluginState, entries } = snapshot;
  const activeOperationId = pluginState?.activeOperationId ?? null;

  // Card refs — used by the editor → sidebar scroll direction. When the
  // active operation changes (from any source), scroll the matching card
  // into view within the rail's own scroll container.
  const cardRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  useEffect(() => {
    if (!activeOperationId) return;
    const node = cardRefs.current.get(activeOperationId);
    node?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeOperationId]);

  const handleCardClick = useCallback(
    (operationId: string) => {
      if (!editor || editor.isDestroyed) return;
      editor.commands.setInlineReviewActiveOperation(operationId);
      editor.commands.scrollInlineReviewOperationIntoView(operationId);
    },
    [editor],
  );

  const handleDiscard = useCallback(
    async (operationId: string) => {
      if (pendingDiscardIds.has(operationId)) return;
      setPendingDiscardIds((current) => {
        const next = new Set(current);
        next.add(operationId);
        return next;
      });
      try {
        // TODO(draft-reject-phase): swap this callback stub for the real
        // per-operation reject flow — reconstructInverse on the draft
        // update rows + Y.applyUpdate under HUNK_REJECT_ORIGIN. Until
        // then the sidebar surfaces intent to the caller and holds a
        // spinner so double-clicks don't fire twice.
        await onDiscardOperation?.(operationId);
      } finally {
        setPendingDiscardIds((current) => {
          const next = new Set(current);
          next.delete(operationId);
          return next;
        });
      }
    },
    [onDiscardOperation, pendingDiscardIds],
  );

  const hasModel = pluginState?.model != null;
  const isEmptyDiff = hasModel && entries.length === 0;

  return (
    <aside
      aria-label="Draft review proposals"
      className={cn(
        // Fixed-width right rail with its own scroll region. Border on the
        // left separates it from the manuscript pane.
        "flex h-full w-72 shrink-0 flex-col border-border-subtle border-l bg-surface-subtle",
        className,
      )}
      data-draft-review-sidebar
    >
      <header className="flex items-center gap-2 border-border-subtle border-b bg-background px-4 py-2">
        <Sparkles className="size-3.5 text-muted-foreground" aria-hidden />
        <p className="text-meta font-semibold uppercase tracking-wide text-muted-foreground">
          <Trans>Proposals</Trans>
        </p>
        <span className="ml-auto tabular-nums text-muted-foreground text-xs">{entries.length}</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!hasModel ? (
          <SidebarStatus>
            <Trans>Loading proposals…</Trans>
          </SidebarStatus>
        ) : isEmptyDiff ? (
          <SidebarStatus>
            <Trans>No changes to review — the draft matches your manuscript.</Trans>
          </SidebarStatus>
        ) : (
          <ol className="flex flex-col gap-2">
            {entries.map((entry) => (
              <OperationCard
                key={entry.operation.operationId}
                ref={(node) => {
                  const map = cardRefs.current;
                  if (node) map.set(entry.operation.operationId, node);
                  else map.delete(entry.operation.operationId);
                }}
                entry={entry}
                active={entry.operation.operationId === activeOperationId}
                pending={pendingDiscardIds.has(entry.operation.operationId)}
                onSelect={() => handleCardClick(entry.operation.operationId)}
                onDiscard={() => handleDiscard(entry.operation.operationId)}
              />
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}

type OperationCardProps = {
  entry: OrderedOperation;
  active: boolean;
  pending: boolean;
  onSelect: () => void;
  onDiscard: () => void;
  ref?: (node: HTMLElement | null) => void;
};

function OperationCard({ entry, active, pending, onSelect, onDiscard, ref }: OperationCardProps) {
  const isWriter = entry.operation.kind === "writer";
  const shapeSummary = summaryForOperation(entry, isWriter);
  const removalPreview = removalPreviewFor(entry);

  return (
    <li
      ref={ref}
      className={cn(
        // Card shell borrows from ComponentCard's token vocabulary. Full
        // border + subtle shadow, no side stripe. Selected state is a
        // stronger border + primary ring rather than a background wash so
        // AI and writer accent colors stay recognisable at a glance.
        "surface-card rounded-lg border border-border-subtle p-3 shadow-xs transition-[border-color,box-shadow] duration-150",
        active && "border-primary shadow-sm ring-2 ring-primary/25",
        !active && "hover:border-border",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={cn("focus-ring flex w-full flex-col items-start gap-1.5 rounded-md text-left")}
      >
        <div className="flex w-full items-center gap-2">
          <AttributionBadge kind={isWriter ? "writer" : "agent"} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {shapeSummary}
          </span>
          {entry.operation.hunkCount > 1 ? (
            <MultiRegionBadge count={entry.operation.hunkCount} />
          ) : null}
        </div>
        {removalPreview ? (
          <p className="line-clamp-2 text-muted-foreground text-xs italic">
            <span aria-hidden>“</span>
            <s className="not-italic">{removalPreview}</s>
            <span aria-hidden>”</span>
          </p>
        ) : null}
      </button>
      <div className="mt-2 flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={pending}
          className="text-muted-foreground hover:text-foreground"
        >
          {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
          <Trans>Discard</Trans>
        </Button>
      </div>
    </li>
  );
}

function AttributionBadge({ kind }: { kind: "agent" | "writer" }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 font-semibold text-[10px] uppercase tracking-wide",
        // Token-driven color pair: agent uses the review-added palette
        // (same green as inline decorations), writer uses the review-writer
        // gold. Both borders + tints stay on brand.
        kind === "agent"
          ? "border border-[color:var(--color-review-added-border)] bg-[color:var(--color-review-added-tint)] text-primary"
          : "border border-[color:var(--color-review-writer-border)] bg-[color:var(--color-review-writer-tint)] text-[color:var(--color-gold)]",
      )}
    >
      {kind === "agent" ? <Trans>AI</Trans> : <Trans>You</Trans>}
    </span>
  );
}

function MultiRegionBadge({ count }: { count: number }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] text-muted-foreground">
      <Trans>{count} changes</Trans>
    </span>
  );
}

function SidebarStatus({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border-subtle border-dashed bg-background px-3 py-4 text-center text-muted-foreground text-xs">
      {children}
    </p>
  );
}

function summaryForOperation(entry: OrderedOperation, isWriter: boolean): React.ReactNode {
  // Honest verb derived from hunk shape — we don't fake a semantic label.
  // "Suggested edits" is the mixed-fallback; writer operations are always
  // narrated in first person so the eye can distinguish them at a glance.
  switch (entry.shape) {
    case "insert":
      return isWriter ? <Trans>You added text</Trans> : <Trans>Added text</Trans>;
    case "delete":
      return isWriter ? <Trans>You removed text</Trans> : <Trans>Removed text</Trans>;
    case "replace":
      return isWriter ? <Trans>You rewrote text</Trans> : <Trans>Rewrote text</Trans>;
    default:
      return isWriter ? <Trans>You edited this passage</Trans> : <Trans>Suggested edits</Trans>;
  }
}

/** First few words of removed text — a real preview, not an invented summary. */
function removalPreviewFor(entry: OrderedOperation): string | null {
  const previewChars = 80;
  for (const hunk of entry.hunks) {
    const text = hunk.deletedText;
    if (!text) continue;
    const trimmed = text.trim();
    if (trimmed.length <= previewChars) return trimmed;
    return `${trimmed.slice(0, previewChars).trimEnd()}…`;
  }
  return null;
}

function collectHunkPositions(
  pluginState: InlineReviewPluginState,
): ReadonlyMap<string, HunkPositionRange | null> {
  const map = new Map<string, HunkPositionRange | null>();
  const model = pluginState.model;
  if (!model) return map;

  // Walk the decoration set to find each hunk's absolute position. The
  // plugin already places these; the sidebar reuses them so it doesn't have
  // to re-decode Y.RelativePosition itself.
  const decorationList = pluginState.decorations.find();
  const decByHunk = new Map<string, { from: number; to: number }>();
  for (const dec of decorationList) {
    const spec = dec.spec as Record<string, unknown> | undefined;
    const hunkId = spec?.["data-review-hunk"];
    if (typeof hunkId !== "string") continue;
    // Prefer inline range over widget position if both are present for the
    // same hunk (a replace produces both — the inline range carries the
    // insertion span we want to scroll to).
    const existing = decByHunk.get(hunkId);
    if (existing && existing.to > existing.from) continue;
    decByHunk.set(hunkId, { from: dec.from, to: dec.to });
  }

  for (const hunk of model.hunks) {
    const dec = decByHunk.get(hunk.hunkId);
    if (!dec) {
      map.set(hunk.hunkId, null);
      continue;
    }
    map.set(hunk.hunkId, {
      from: dec.from,
      to: dec.to,
      hasDeletion: Boolean(hunk.deletedText && hunk.deletedText.length > 0),
    });
  }
  return map;
}

function sidebarSnapshotEqual(a: SidebarSnapshot, b: SidebarSnapshot): boolean {
  if (a.pluginState === b.pluginState && a.entries === b.entries) return true;
  if (a.pluginState?.model !== b.pluginState?.model) return false;
  if (a.pluginState?.activeOperationId !== b.pluginState?.activeOperationId) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i += 1) {
    const ae = a.entries[i];
    const be = b.entries[i];
    if (!ae || !be) return false;
    if (ae.operation.operationId !== be.operation.operationId) return false;
    if (ae.firstPos !== be.firstPos) return false;
    if (ae.shape !== be.shape) return false;
  }
  return true;
}
