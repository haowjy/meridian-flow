import { useEffect, useRef } from "react";
import { MergeView, type MergeConfig } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

interface SnapshotPreviewDiffProps {
  baseText: string;
  snapshotText: string;
}

export function SnapshotPreviewDiff({
  baseText,
  snapshotText,
}: SnapshotPreviewDiffProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const config: MergeConfig = {
      orientation: "a-b" as const,
      collapseUnchanged: { margin: 4, minSize: 8 },
    };

    if (mergeViewRef.current == null) {
      mergeViewRef.current = new MergeView({
        parent: container,
        a: {
          doc: baseText,
          extensions: [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        },
        b: {
          doc: snapshotText,
          extensions: [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        },
        highlightChanges: true,
        gutter: true,
        ...config,
      });
      return;
    }

    replaceDoc(mergeViewRef.current.a, baseText);
    replaceDoc(mergeViewRef.current.b, snapshotText);
    mergeViewRef.current.reconfigure(config);
  }, [baseText, snapshotText]);

  useEffect(() => {
    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="h-full min-h-56 overflow-auto" />;
}

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
