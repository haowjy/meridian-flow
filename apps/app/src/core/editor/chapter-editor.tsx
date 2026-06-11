import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo } from "react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { getDocumentSessionTransport } from "@/core/transport/document-session-transport";
import { createEditorConfig } from "./config";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

declare global {
  interface Window {
    __MERIDIAN_EDITOR_DEBUG__?: {
      getText: () => string;
      getFragmentText: () => string;
      documentId: string;
    };
  }
}

type ChapterEditorProps = {
  documentId: string;
  onSyncStatus?: (status: string) => void;
  onError?: (message: string) => void;
};

export function ChapterEditor({ documentId, onSyncStatus, onError }: ChapterEditorProps) {
  const document = useMemo(() => getOrCreateDoc(documentId), [documentId]);
  const awareness = useMemo(() => getOrCreateAwareness(document), [document]);
  const transport = useMemo(() => getDocumentSessionTransport(), []);

  useEffect(() => {
    const channel = transport.subscribe({ documentId, document, awareness });
    const unsubscribeStatus = channel.subscribeStatus((state) => {
      if (state.kind === "connected") onSyncStatus?.("subscribed");
      else if (state.kind === "connecting") onSyncStatus?.("connected");
      else onSyncStatus?.(state.kind);
    });
    const unsubscribeError = channel.onError((error) => onError?.(error.reason));
    return () => {
      unsubscribeStatus();
      unsubscribeError();
      channel.destroy();
    };
  }, [awareness, document, documentId, onError, onSyncStatus, transport]);

  const editor = useEditor({
    ...createEditorConfig({
      document,
      awareness,
      editorProps: {
        attributes: {
          "data-testid": "chapter-editor",
          "data-document-id": documentId,
          "data-fragment-name": PROSEMIRROR_FRAGMENT_NAME,
          class: "editor-surface",
        },
      },
    }),
    immediatelyRender: false,
  });

  useEffect(() => {
    window.__MERIDIAN_EDITOR_DEBUG__ = {
      documentId,
      getText: () => editor?.getText() ?? "",
      getFragmentText: () => document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toString(),
    };
    return () => {
      if (window.__MERIDIAN_EDITOR_DEBUG__?.documentId === documentId) {
        delete window.__MERIDIAN_EDITOR_DEBUG__;
      }
    };
  }, [document, documentId, editor]);

  return <EditorContent editor={editor} />;
}

const docCache = new Map<string, Y.Doc>();
const awarenessCache = new WeakMap<Y.Doc, Awareness>();

function getOrCreateDoc(documentId: string): Y.Doc {
  let doc = docCache.get(documentId);
  if (!doc) {
    doc = new Y.Doc();
    docCache.set(documentId, doc);
  }
  return doc;
}

function getOrCreateAwareness(document: Y.Doc): Awareness {
  let awareness = awarenessCache.get(document);
  if (!awareness) {
    awareness = new Awareness(document);
    awarenessCache.set(document, awareness);
  }
  return awareness;
}
