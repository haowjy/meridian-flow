import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { ReviewChunk } from "./types";
import { editOpsToMergeChanges } from "./ops-to-changes";

export interface UnifiedReviewParams {
  parent: Element;
  baseText: string;
  proposedText: string;
  chunks: ReviewChunk[];
  onAcceptChunk: (chunkId: string) => void;
  onRejectChunk: (chunkId: string) => void;
}

export interface UnifiedReviewHandle {
  update(params: Pick<UnifiedReviewParams, "baseText" | "proposedText" | "chunks">): void;
  destroy(): void;
}

// Scoped to the CM6 view so button styles don't leak globally.
const chunkControlTheme = EditorView.theme({
  ".chunk-accept": {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    cursor: "pointer",
    border: "1px solid transparent",
    marginRight: "4px",
    background: "var(--theme-primary, #16a34a)",
    color: "var(--theme-primary-foreground, #fff)",
    fontFamily: "inherit",
    lineHeight: "1.5",
  },
  ".chunk-accept:hover": {
    background: "var(--theme-primary-hover, #15803d)",
  },
  ".chunk-reject": {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    cursor: "pointer",
    border: "1px solid currentColor",
    marginRight: "4px",
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    lineHeight: "1.5",
    opacity: "0.7",
  },
  ".chunk-reject:hover": {
    opacity: "1",
  },
});

function createReviewView(params: UnifiedReviewParams): EditorView {
  const { parent, baseText, proposedText, chunks, onAcceptChunk, onRejectChunk } = params;
  const mergeChanges = editOpsToMergeChanges(chunks);

  // For Slice 2, all per-chunk actions map to proposal-level accept/reject
  // (the EditorPanel maps onAcceptChunk → onAcceptProposal). Per-chunk partial
  // apply is Slice 4. We use the first chunk's id as the representative id.
  const firstChunkId = chunks[0]?.id ?? "";

  const extension = unifiedMergeView({
    original: baseText,
    highlightChanges: true,
    gutter: false,
    // mergeControls factory is called once per button type ("accept"|"reject") per chunk.
    // _action is CM6's built-in editor mutation — NOT called here because proposal
    // acceptance is server-side (via sendProposalAccept), not an in-editor edit.
    mergeControls: (type, _action) => {
      const btn = document.createElement("button");
      if (type === "accept") {
        btn.className = "chunk-accept";
        btn.title = "Accept this change";
        btn.textContent = "✓ Accept";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          onAcceptChunk(firstChunkId);
        });
      } else {
        btn.className = "chunk-reject";
        btn.title = "Reject this change";
        btn.textContent = "✗ Reject";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          onRejectChunk(firstChunkId);
        });
      }
      return btn;
    },
    diffConfig: {
      // Path A: supply our own Change[] derived directly from Yjs delta ops.
      // Ignores the a/b string args — positions are already correct.
      override: () => mergeChanges,
    },
  });

  return new EditorView({
    state: EditorState.create({
      doc: proposedText,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        chunkControlTheme,
        extension,
      ],
    }),
    parent,
  });
}

export function mountUnifiedReviewView(params: UnifiedReviewParams): UnifiedReviewHandle {
  params.parent.replaceChildren();

  let currentParams = params;
  let view = createReviewView(params);

  return {
    update(next) {
      // Compare chunk IDs instead of reference equality — chunks are rebuilt
      // on every derivation so the array reference is always new.
      const chunksMatch =
        next.chunks.length === currentParams.chunks.length &&
        next.chunks.every((c, i) => c.id === currentParams.chunks[i]?.id);
      const unchanged =
        next.baseText === currentParams.baseText &&
        next.proposedText === currentParams.proposedText &&
        chunksMatch;

      if (unchanged) return;

      view.destroy();
      params.parent.replaceChildren();
      currentParams = { ...currentParams, ...next };
      view = createReviewView(currentParams);
    },
    destroy() {
      view.destroy();
    },
  };
}
