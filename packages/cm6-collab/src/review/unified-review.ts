import { type Extension, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { ReviewChunk } from "./types";
import { editOpsToMergeChanges } from "./ops-to-changes";
import { chunkNavigationKeymap } from "./chunk-navigation";

export interface UnifiedReviewParams {
  parent: Element;
  baseText: string;
  proposedText: string;
  chunks: ReviewChunk[];
  onAcceptChunk: (chunk: ReviewChunk) => void;
  onRejectChunk: (chunk: ReviewChunk) => void;
  onEditChunk?: (chunk: ReviewChunk) => void;
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
  ".chunk-edit": {
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
  ".chunk-edit:hover": {
    opacity: "1",
  },
});

function createReviewView(params: UnifiedReviewParams, extraExtensions: Extension[] = []): EditorView {
  const {
    parent,
    baseText,
    proposedText,
    chunks,
    onAcceptChunk,
    onRejectChunk,
    onEditChunk,
  } = params;
  const mergeChanges = editOpsToMergeChanges(chunks);

  // mergeControls is called sequentially: (accept, chunk0), (reject, chunk0),
  // (accept, chunk1), (reject, chunk1), ... — 2 calls per chunk. We use a call
  // counter to map each button back to the correct ReviewChunk.
  let mergeControlCallCount = 0;

  const extension = unifiedMergeView({
    original: baseText,
    highlightChanges: true,
    gutter: false,
    // mergeControls factory is called once per button type ("accept"|"reject") per chunk.
    // _action is CM6's built-in editor mutation — NOT called here because proposal
    // acceptance is server-side (via sendProposalAccept), not an in-editor edit.
    mergeControls: (type, _action) => {
      const chunkIndex = Math.floor(mergeControlCallCount / 2);
      mergeControlCallCount++;
      // chunks is guaranteed non-empty when mergeControls is called (CM6 only
      // renders controls for changed regions), so the non-null assertion is safe.
      const chunk = (chunks[chunkIndex] ?? chunks[0])!;

      if (type === "accept") {
        const controls = document.createElement("span");

        const acceptBtn = document.createElement("button");
        acceptBtn.className = "chunk-accept";
        acceptBtn.title = "Accept this change";
        acceptBtn.textContent = "✓ Accept";
        acceptBtn.addEventListener("click", (e) => {
          e.preventDefault();
          if (chunk) onAcceptChunk(chunk);
        });
        controls.appendChild(acceptBtn);

        if (onEditChunk) {
          const editBtn = document.createElement("button");
          editBtn.className = "chunk-edit";
          editBtn.title = "Edit this change before accepting";
          editBtn.textContent = "Edit";
          editBtn.addEventListener("click", (e) => {
            e.preventDefault();
            if (chunk) onEditChunk(chunk);
          });
          controls.appendChild(editBtn);
        }

        return controls;
      } else {
        const rejectBtn = document.createElement("button");
        rejectBtn.className = "chunk-reject";
        rejectBtn.title = "Reject this change";
        rejectBtn.textContent = "✗ Reject";
        rejectBtn.addEventListener("click", (e) => {
          e.preventDefault();
          if (chunk) onRejectChunk(chunk);
        });
        return rejectBtn;
      }
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
        ...extraExtensions,
      ],
    }),
    parent,
  });
}

export function mountUnifiedReviewView(params: UnifiedReviewParams): UnifiedReviewHandle {
  params.parent.replaceChildren();

  let currentParams = params;
  // Keyboard navigation state — lives in closure, not React state.
  let focusedIndex = 0;

  // Build the keymap extension once; it reads from closures so it stays fresh
  // across remounts without needing to be recreated.
  const navKeymap = chunkNavigationKeymap({
    getChunks: () => currentParams.chunks,
    getFocusedChunkIndex: () => focusedIndex,
    setFocusedChunkIndex: (idx) => {
      focusedIndex = idx;
      // Visible evidence of navigation (scroll-to-chunk is Slice 4+).
      console.debug("[chunk-nav] focused chunk index:", idx, currentParams.chunks[idx]?.id);
    },
    onAcceptChunk: (id) => {
      const chunk = currentParams.chunks.find((c) => c.id === id);
      if (chunk) currentParams.onAcceptChunk(chunk);
    },
    onRejectChunk: (id) => {
      const chunk = currentParams.chunks.find((c) => c.id === id);
      if (chunk) currentParams.onRejectChunk(chunk);
    },
  });

  let view = createReviewView(params, [navKeymap]);

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
      // Reset focused index when chunks change — stale index could go out of bounds.
      focusedIndex = 0;
      view = createReviewView(currentParams, [navKeymap]);
    },
    destroy() {
      view.destroy();
    },
  };
}
