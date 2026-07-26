/**
 * mounted-editor — the sole authority over a collaborative editor's lifetime.
 *
 * Collaboration binds to one concrete Y.Doc fragment at construction, so
 * rebuilding a TipTap editor destroys its Yjs UndoManager and drops keystrokes
 * in flight. That rule is enforced structurally here rather than by convention:
 *
 * - `EditorMountIdentity` holds every fact TipTap can only learn at
 *   construction, and `editorMountKey()` turns it into the React key that owns
 *   the mount. A remount is therefore a key decision at one boundary.
 * - `useMountedEditor()` builds the editor from that identity and hands
 *   `useEditor` no dependency array, so there is no list for a later live
 *   option to sneak into.
 * - Everything that may change while the writer keeps typing arrives as
 *   `EditorSurfaceOptions` and reaches the running editor through TipTap's own
 *   `setOptions` sync (plus `setEditable`, which that sync deliberately skips).
 */
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor, EditorOptions } from "@tiptap/core";
import { useEditor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";

import type { AgentNameStore } from "./agent-name-store";
import { createEditorConfig } from "./config";
import type { DocumentSession } from "./document-session";

type EditorMountBase = {
  documentId: string;
  /** Figure rendering resolves references against the owning project. */
  projectId?: string;
  schemaType: YjsTrackedSchemaType;
  /** CollaborationCaret is an extension, so toggling peers needs a new editor. */
  collaborationDecorations: boolean;
};

/**
 * The construction identity of one editor. Every field changes which extensions
 * or which shared document the editor is built from, so any change to it is a
 * remount — and nothing outside this type may cause one.
 */
export type EditorMountIdentity =
  | (EditorMountBase & {
      surface: "live";
      /** Not-yet-materialized document kept off server transport. */
      detached: boolean;
    })
  | (EditorMountBase & {
      surface: "review";
      /** Generation-fenced branch review room from the preview DTO. */
      roomName: string;
      draftId: string;
    });

/** Values that may change while the same editor keeps running. */
export type EditorSurfaceOptions = {
  editable: boolean;
  /**
   * ProseMirror props: DOM attributes and handlers. Applied live, so a caller
   * that rebuilds this object pays an extra `view.setProps` — never a remount.
   */
  editorProps: NonNullable<EditorOptions["editorProps"]>;
};

/** Room the `DocumentSessionRegistry` binds this editor to. */
export function editorRoomKey(identity: EditorMountIdentity): string {
  return identity.surface === "review" ? identity.roomName : identity.documentId;
}

/** React key that owns the editor's lifetime. Equal keys keep the instance. */
export function editorMountKey(identity: EditorMountIdentity): string {
  const shared = `${identity.documentId}|${identity.projectId ?? ""}|${identity.schemaType}|${identity.collaborationDecorations}`;
  return identity.surface === "review"
    ? `review|${identity.roomName}|${identity.draftId}|${shared}`
    : `live|${identity.documentId}|${identity.detached}|${shared}`;
}

export type MountedEditorInput = {
  identity: EditorMountIdentity;
  /**
   * Session for `editorRoomKey(identity)`. The caller's mount key covers every
   * input the session lookup depends on, so it is constant for this mount.
   */
  session: DocumentSession;
  /** Subscribable name lookup; the projection repaints, the editor is not rebuilt. */
  agentNames: AgentNameStore;
  placeholder: string;
  surface: EditorSurfaceOptions;
};

export function useMountedEditor({
  identity,
  session,
  agentNames,
  placeholder,
  surface,
}: MountedEditorInput): Editor | null {
  // Frozen on first render: identity is constant for the mount by construction
  // (the mount key covers it), and freezing keeps the extension array's identity
  // stable so TipTap's option sync never sees a reason to touch the schema.
  const [construction] = useState(() =>
    createEditorConfig({
      document: session.document,
      awareness: session.awareness,
      cursorProvider: session.cursorProvider,
      schemaType: identity.schemaType,
      figureRenderContext: { projectId: identity.projectId, documentId: identity.documentId },
      showCollaborationDecorations: identity.collaborationDecorations,
      enableDraftInlineReview: identity.surface === "review",
      markerStore: identity.surface === "review" ? undefined : session.markerStore,
      agentNames,
      placeholder,
      autofocus: false,
    }),
  );

  const options = useMemo(
    () => ({
      ...construction,
      editable: surface.editable,
      editorProps: { ...construction.editorProps, ...surface.editorProps },
      immediatelyRender: false,
      shouldRerenderOnTransaction: false,
    }),
    [construction, surface.editable, surface.editorProps],
  );

  // No dependency array: TipTap 3 then syncs changed options onto the live
  // instance with `setOptions()` instead of rebuilding it.
  const editor = useEditor(options);

  useEffect(() => {
    // That sync re-asserts the editor's current editable flag rather than the
    // one it was handed, so editability needs its own seam.
    if (editor && !editor.isDestroyed) editor.setEditable(surface.editable, false);
  }, [editor, surface.editable]);

  return editor;
}
