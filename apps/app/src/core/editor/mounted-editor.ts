/**
 * mounted-editor — the sole authority over a collaborative editor's lifetime.
 *
 * The binding attaches to the session's copy at construction, so rebuilding a
 * TipTap editor drops keystrokes
 * in flight. That rule is enforced structurally here rather than by convention:
 *
 * - `EditorMountIdentity` holds every fact TipTap can only learn at
 *   construction, and `editorMountKey()` turns it into the React key that owns
 *   the mount. A remount is therefore a key decision at one boundary.
 * - Everything that may change while the writer keeps typing arrives as
 *   `EditorSurfaceOptions` and reaches the running editor through TipTap's own
 *   `setOptions` sync (plus `setEditable`, which that sync deliberately skips).
 */
import type { Filetype, TrackedSchemaType } from "@meridian/contracts/protocol";
import { Editor, type EditorOptions } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useEffect, useMemo, useRef, useState } from "react";

import { createEditorConfig, type EditorUser } from "./config";
import type { DocumentSession } from "./document-session";
import type { AtReferenceCatalog } from "./extensions/at-reference";
import type { ReferenceDropOptions } from "./extensions/reference-drop";
import type { SlashCommandCatalog } from "./extensions/slash";
import type { WikilinkPasteCatalog } from "./links";
import { gateCaretPresence } from "./local-presence";
import { markEditorTarget } from "./reading-position-navigation";

type EditorMountBase = {
  documentId: string;
  bindingKey?: string;
  projectId?: string;
  viewingOwner?: string;
  schemaType: TrackedSchemaType;
  filetype?: Filetype;
  /** CollaborationCaret is an extension, so toggling peers needs a new editor. */
  collaborationDecorations: boolean;
};

/**
 * The construction identity of one editor. Every field changes which extensions
 * or which shared document the editor is built from, so any change to it is a
 * remount — and nothing outside this type may cause one.
 */
export type EditorMountIdentity = EditorMountBase & {
  detached: boolean;
};

export type EditorSurfaceOptions = {
  editable: boolean;
  editorProps: NonNullable<EditorOptions["editorProps"]>;
  publishPresence: boolean;
};

export function editorMountKey(identity: EditorMountIdentity): string {
  const filetype = identity.schemaType === "code" ? (identity.filetype ?? "") : "";
  return `${identity.bindingKey ?? identity.documentId}|${identity.projectId ?? ""}|${identity.viewingOwner ?? ""}|${identity.schemaType}|${filetype}|${identity.collaborationDecorations}`;
}

export type MountedEditorInput = {
  identity: EditorMountIdentity;
  session: DocumentSession;
  user: EditorUser;
  placeholder: string;
  slashCommandCatalog?: () => SlashCommandCatalog | null;
  atReferenceCatalog?: () => AtReferenceCatalog | null;
  referenceDrop?: ReferenceDropOptions;
  wikilinkPasteCatalog?: () => WikilinkPasteCatalog | null;
  surface: EditorSurfaceOptions;
};

export function useMountedEditor({
  identity,
  session,
  user,
  placeholder,
  slashCommandCatalog,
  atReferenceCatalog,
  referenceDrop,
  wikilinkPasteCatalog,
  surface,
}: MountedEditorInput): Editor | null {
  const catalogRef = useRef(slashCommandCatalog);
  catalogRef.current = slashCommandCatalog;
  const atReferenceCatalogRef = useRef(atReferenceCatalog);
  atReferenceCatalogRef.current = atReferenceCatalog;
  const referenceDropRef = useRef(referenceDrop);
  referenceDropRef.current = referenceDrop;
  const wikilinkPasteCatalogRef = useRef(wikilinkPasteCatalog);
  wikilinkPasteCatalogRef.current = wikilinkPasteCatalog;
  const publishPresenceRef = useRef(surface.publishPresence);
  publishPresenceRef.current = surface.publishPresence;
  // Frozen on first render: identity is constant for the mount by construction
  // (the mount key covers it), and freezing keeps the extension array's identity
  // stable so TipTap's option sync never sees a reason to touch the schema.
  const [construction] = useState(() => {
    const caretGate = gateCaretPresence(session.presence, () => publishPresenceRef.current);
    const editorConfig = createEditorConfig({
      copy: { docs: session.docs, publish: (changes) => session.publish(changes) },
      history: session.history,
      presence: caretGate.presence,
      schemaType: identity.schemaType,
      filetype: identity.filetype,
      assetRenderContext: { projectId: identity.projectId, owner: identity.viewingOwner },
      showCollaborationDecorations: identity.collaborationDecorations,
      user,
      placeholder,
      autofocus: false,
      slashCommands: { catalog: () => catalogRef.current?.() ?? null },
      atReferences: { catalog: () => atReferenceCatalogRef.current?.() ?? null },
      referenceDrop: referenceDrop
        ? {
            draggedEntries: (event) => referenceDropRef.current?.draggedEntries(event) ?? null,
            content: (schema, entries) =>
              referenceDropRef.current?.content(schema, entries) ?? null,
            label: (kind) => referenceDropRef.current?.label(kind) ?? referenceDrop.label(kind),
          }
        : undefined,
      wikilinkPaste: { catalog: () => wikilinkPasteCatalogRef.current?.() ?? null },
    });
    return {
      caretGate,
      editorConfig,
      initialOptions: {
        ...editorConfig,
        editable: surface.editable,
        editorProps: { ...editorConfig.editorProps, ...surface.editorProps },
      },
      session,
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
    if (!surface.publishPresence) construction.caretGate.retire();
  }, [construction, surface.publishPresence]);

  useEffect(() => {
    // TipTap's useEditor defers construction into its own passive effect when
    // immediatelyRender is false. Owning construction here is what creates one
    // gap-free synchronous bracket around every extension lifecycle mutation.
    const { editor: mounted, release } = construction.session.bindEditor(
      () => new Editor(construction.initialOptions),
    );
    const targetScroll = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.scrolledIntoView) markEditorTarget(mounted);
    };
    mounted.on("transaction", targetScroll);
    setEditor(mounted);
    return () => {
      mounted.off("transaction", targetScroll);
      release();
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
