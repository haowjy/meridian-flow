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
 * - Everything that may change while the writer keeps typing arrives as
 *   `EditorSurfaceOptions` and reaches the running editor through TipTap's own
 *   `setOptions` sync (plus `setEditable`, which that sync deliberately skips).
 */
import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { Editor, type EditorOptions } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";

import type { WikilinkCatalog } from "@/core/completion";

import type { AgentNameStore } from "./agent-name-store";
import { createEditorConfig } from "./config";
import type { DocumentSession } from "./document-session";
import type { SlashCommandCatalog } from "./extensions/slash";
import { createSchemaRepairWitness, type SchemaRepairEvent } from "./schema-repair-witness";

type EditorMountBase = {
  documentId: string;
  /** Asset image rendering resolves `asset:` refs against the owning project. */
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
  /**
   * Reads the insertion catalog when the menu opens. Mounting the extension is
   * a construction fact; its localized labels and host callbacks are not, so
   * they arrive through this getter instead of the mount key.
   */
  slashCommandCatalog?: () => SlashCommandCatalog | null;
  /**
   * Reads the project's documents when the `[[` menu opens. Same reason as the
   * slash catalog: mounting the trigger is a construction fact, and the list it
   * offers — which changes every time the writer creates or renames a file —
   * is not.
   */
  wikilinkCatalog?: () => WikilinkCatalog | null;
  surface: EditorSurfaceOptions;
  /** The horizon expired, so any resulting verdict must carry that limitation. */
  evidenceDegraded?: boolean;
};

export function useMountedEditor({
  identity,
  session,
  agentNames,
  placeholder,
  slashCommandCatalog,
  wikilinkCatalog,
  surface,
  evidenceDegraded = false,
}: MountedEditorInput): Editor | null {
  // The getter is read at menu-open time, so freezing the reference is safe
  // only if it never goes stale. Keep the live one in a ref the frozen getter
  // reads through.
  const catalogRef = useRef(slashCommandCatalog);
  catalogRef.current = slashCommandCatalog;
  const wikilinkCatalogRef = useRef(wikilinkCatalog);
  wikilinkCatalogRef.current = wikilinkCatalog;
  // Frozen on first render: identity is constant for the mount by construction
  // (the mount key covers it), and freezing keeps the extension array's identity
  // stable so TipTap's option sync never sees a reason to touch the schema.
  const [construction] = useState(() => {
    const editorConfig = createEditorConfig({
      document: session.document,
      // The session owns whether this client is visible (inline review suspends
      // it), so it owns every local awareness field the editor publishes — the
      // caret's included.
      presence: session.presence,
      schemaType: identity.schemaType,
      assetRenderContext: { projectId: identity.projectId },
      showCollaborationDecorations: identity.collaborationDecorations,
      enableDraftInlineReview: identity.surface === "review",
      markerStore: identity.surface === "review" ? undefined : session.markerStore,
      agentNames,
      placeholder,
      autofocus: false,
      slashCommands: { catalog: () => catalogRef.current?.() ?? null },
      wikilinks: { catalog: () => wikilinkCatalogRef.current?.() ?? null },
    });
    return {
      editorConfig,
      initialOptions: {
        ...editorConfig,
        editable: surface.editable,
        editorProps: { ...editorConfig.editorProps, ...surface.editorProps },
      },
      witness: {
        document: session.document,
        evidenceDegraded,
        onRepair: (event: SchemaRepairEvent) => session.reportSchemaRepair(event),
      },
    };
  });

  const options = useMemo<Partial<EditorOptions>>(
    () => ({
      ...construction.editorConfig,
      editable: surface.editable,
      editorProps: { ...construction.editorConfig.editorProps, ...surface.editorProps },
    }),
    [construction, surface.editable, surface.editorProps],
  );

  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    // TipTap's useEditor defers construction into its own passive effect when
    // immediatelyRender is false. Owning construction here is what creates one
    // gap-free synchronous bracket around every extension lifecycle mutation.
    const witness = createSchemaRepairWitness(construction.witness);
    let mounted: Editor;
    try {
      mounted = new Editor(construction.initialOptions);
      // Atomic with construction: live observation starts before this effect
      // yields, rather than in a later effect or TipTap's deferred onCreate.
      witness.enterLive(mounted);
    } catch (error) {
      witness.destroy();
      throw error;
    }
    setEditor(mounted);
    return () => {
      witness.destroy();
      if (!mounted.isDestroyed) mounted.destroy();
    };
  }, [construction]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // Match useEditor's option reconciliation without letting changed surface
    // options become construction dependencies.
    editor.setOptions({ ...options, editable: editor.isEditable });
    editor.setEditable(surface.editable, false);
  }, [editor, options, surface.editable]);

  return editor;
}
