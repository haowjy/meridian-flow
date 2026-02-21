import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView, type MergeConfig } from "@codemirror/merge";

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

  const view = createMergeView(params);

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
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    },
    b: {
      doc: params.proposedText,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    },
    highlightChanges: true,
    gutter: true,
    ...params.config,
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
