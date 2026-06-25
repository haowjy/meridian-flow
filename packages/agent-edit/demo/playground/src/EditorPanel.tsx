// Read-only ProseMirror view bound to a doc's Y.XmlFragment via ySyncPlugin.
// The agent is the only writer; user input is blocked via editable: false.
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useEffect, useRef } from "react";
import { ySyncPlugin } from "y-prosemirror";
import type * as Y from "yjs";

interface EditorPanelProps {
  doc: Y.Doc;
  schema: Schema;
}

export function EditorPanel({ doc, schema }: EditorPanelProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const state = EditorState.create({
      schema,
      plugins: [ySyncPlugin(fragment)],
    });
    const view = new EditorView(mountRef.current, {
      state,
      editable: () => false,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [doc, schema]);

  return <div ref={mountRef} className="editor-mount" />;
}
