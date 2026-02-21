import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView, type MergeConfig } from "@codemirror/merge";
import type { ReviewChunk } from "./types";
import { editOpsToMergeChanges } from "./ops-to-changes";

// ---------------------------------------------------------------------------
// Legacy API — used by SnapshotPreviewDiff (simple split view, no chunks)
// ---------------------------------------------------------------------------

export interface ProposalReviewMergeViewParams {
  parent: Element;
  baseText: string;
  proposedText: string;
  config?: MergeConfig;
}

export interface ProposalReviewMergeViewHandle {
  update: (params: Omit<ProposalReviewMergeViewParams, "parent">) => void;
  destroy: () => void;
}

export function mountProposalReviewMergeView(
  params: ProposalReviewMergeViewParams,
): ProposalReviewMergeViewHandle {
  params.parent.replaceChildren();

  let view = createMergeView(params);

  return {
    update: (next) => {
      replaceDoc(view.a, next.baseText);
      replaceDoc(view.b, next.proposedText);
      if (next.config) {
        view.reconfigure(next.config);
      }
    },
    destroy: () => {
      view.destroy();
    },
  };
}

function createMergeView(params: ProposalReviewMergeViewParams): MergeView {
  return new MergeView({
    parent: params.parent,
    a: {
      doc: params.baseText,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
    },
    b: {
      doc: params.proposedText,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
    },
    highlightChanges: true,
    gutter: true,
    ...params.config,
  });
}

// ---------------------------------------------------------------------------
// New API — changeset-driven split review view (Slice 3)
// ---------------------------------------------------------------------------

export interface SplitReviewParams {
  parent: Element;
  baseText: string;
  proposedText: string;
  chunks: ReviewChunk[];
  onAcceptChunk: (chunkId: string) => void;
  onRejectChunk: (chunkId: string) => void;
}

export interface SplitReviewHandle {
  update(params: Pick<SplitReviewParams, "baseText" | "proposedText" | "chunks">): void;
  destroy(): void;
}

/**
 * Mounts a side-by-side MergeView driven by changeset-derived diffs.
 *
 * Accept/reject buttons are placed in the gutter between panes using
 * MergeView's `renderRevertControl` hook (the closest equivalent to
 * unifiedMergeView's `mergeControls` option, which MergeView does not expose).
 * For Slice 3, both buttons use the first chunk's id — chunk-level partial
 * apply is deferred to Slice 4.
 *
 * TODO: @codemirror/merge@6.12.0 may still run `presentableDiff` normalization
 * even when `diffConfig.override` is supplied. If split-view diff regions don't
 * exactly match the changeset-derived ops (e.g., extra char-level splits), this
 * is a known issue deferred to a follow-up investigation.
 */
export function mountSplitReviewView(params: SplitReviewParams): SplitReviewHandle {
  params.parent.replaceChildren();

  let currentParams = params;
  let view = createSplitView(params);

  return {
    update(next) {
      const chunksMatch =
        next.chunks.length === currentParams.chunks.length &&
        next.chunks.every((c, i) => c.id === currentParams.chunks[i]?.id);
      const unchanged =
        next.baseText === currentParams.baseText &&
        next.proposedText === currentParams.proposedText &&
        chunksMatch;

      if (unchanged) return;

      // Destroy and remount since chunks (= diff override) may have changed.
      view.destroy();
      params.parent.replaceChildren();
      currentParams = { ...currentParams, ...next };
      view = createSplitView(currentParams);
    },
    destroy() {
      view.destroy();
    },
  };
}

function createSplitView(params: SplitReviewParams): MergeView {
  const { parent, baseText, proposedText, chunks, onAcceptChunk, onRejectChunk } = params;
  const mergeChanges = editOpsToMergeChanges(chunks);

  // For Slice 3, all per-chunk actions map to proposal-level accept/reject.
  // Per-chunk partial apply is Slice 4.
  const firstChunkId = chunks[0]?.id ?? "";

  return new MergeView({
    parent,
    a: {
      doc: baseText,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
    },
    b: {
      doc: proposedText,
      extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false)],
    },
    highlightChanges: true,
    gutter: true,
    diffConfig: {
      // Supply our own Change[] derived directly from Yjs delta ops,
      // bypassing MergeView's Myers diff.
      // TODO: @codemirror/merge may still call presentableDiff normalization
      // despite the override — deferring to follow-up if split diffs look off.
      override: () => mergeChanges,
    },
    // Use renderRevertControl to inject Accept + Reject buttons per chunk gutter.
    // MergeView has no native mergeControls option (unlike unifiedMergeView),
    // so revertControls is the closest hook available. Since both panes are
    // read-only, CM6's built-in revert dispatch is a no-op — our click handlers
    // call onAcceptChunk/onRejectChunk directly.
    revertControls: "a-to-b",
    renderRevertControl: () => {
      const container = document.createElement("div");
      container.style.cssText =
        "display:flex;flex-direction:column;gap:2px;padding:2px;align-items:stretch;";

      const acceptBtn = document.createElement("button");
      acceptBtn.type = "button";
      acceptBtn.title = "Accept this change";
      acceptBtn.textContent = "✓ Accept";
      acceptBtn.style.cssText = [
        "display:inline-flex;align-items:center;justify-content:center;",
        "padding:2px 6px;border-radius:4px;font-size:11px;cursor:pointer;",
        "border:1px solid transparent;",
        "background:var(--theme-primary,#16a34a);",
        "color:var(--theme-primary-foreground,#fff);",
        "font-family:inherit;line-height:1.5;white-space:nowrap;",
      ].join("");
      acceptBtn.addEventListener("click", (e) => {
        e.preventDefault();
        // stopPropagation prevents MergeView's revert click handler from firing.
        e.stopPropagation();
        onAcceptChunk(firstChunkId);
      });

      const rejectBtn = document.createElement("button");
      rejectBtn.type = "button";
      rejectBtn.title = "Reject this change";
      rejectBtn.textContent = "✗ Reject";
      rejectBtn.style.cssText = [
        "display:inline-flex;align-items:center;justify-content:center;",
        "padding:2px 6px;border-radius:4px;font-size:11px;cursor:pointer;",
        "border:1px solid currentColor;opacity:0.7;",
        "background:transparent;",
        "font-family:inherit;line-height:1.5;white-space:nowrap;",
      ].join("");
      rejectBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onRejectChunk(firstChunkId);
      });

      container.appendChild(acceptBtn);
      container.appendChild(rejectBtn);
      return container;
    },
  });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function replaceDoc(view: EditorView, nextText: string): void {
  const current = view.state.doc.toString();
  if (current === nextText) {
    return;
  }

  view.dispatch({
    changes: {
      from: 0,
      to: current.length,
      insert: nextText,
    },
  });
}
