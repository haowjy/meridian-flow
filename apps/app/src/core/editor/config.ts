/**
 * editor config — assembles the TipTap editor option set for a document session.
 *
 * Wires the Meridian node/mark extensions, collaboration (Yjs `Y.Doc` +
 * awareness/caret) and code-highlight extensions into a `createEditorConfig`
 * factory, plus the `EditorUser` type and a sample document. Owns editor wiring,
 * not the session lifecycle (see `document-session.ts`).
 */

import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { type EditorOptions, type Extensions, Node } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { DraftInlineReviewExtension } from "./extensions/inline-review";
import { LiveRangeNavigationExtension } from "./extensions/LiveRangeNavigationExtension";
import {
  MeridianBulletList,
  MeridianCode,
  MeridianCodeBlockLowlight,
  MeridianEm,
  MeridianFigure,
  MeridianHardBreak,
  MeridianHorizontalRule,
  MeridianImage,
  MeridianJsxContainer,
  MeridianJsxLeaf,
  MeridianLink,
  MeridianListItem,
  MeridianOrderedList,
  MeridianStrong,
  MeridianTable,
  MeridianTableCell,
  MeridianTableHeader,
  MeridianTableRow,
} from "./extensions/meridian-extensions";
import { markdownTableClipboardParser } from "./markdown-paste";
import { REVIEW_APPLY_ORIGIN, REVIEW_DISCARD_ORIGIN } from "./review-origins";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

export type EditorUser = {
  name: string;
  color: string;
};

export type AwarenessProvider = {
  awareness: Awareness;
};

export type FigureRenderContext = {
  projectId?: string;
  documentId?: string;
};

export type CreateEditorExtensionsOptions = {
  document: Y.Doc;
  awareness: Awareness;
  schemaType?: YjsTrackedSchemaType;
  cursorProvider?: AwarenessProvider;
  user?: EditorUser;
  figureRenderContext?: FigureRenderContext;
  /** Render remote cursor/selection decorations from awareness. */
  showCollaborationDecorations?: boolean;
  /**
   * Mount the DraftInlineReviewExtension when the editor is bound to a draft
   * room. Live editors omit this flag so they never pay the extra plugin cost.
   */
  enableDraftInlineReview?: boolean;
};

export type CreateEditorConfigOptions = CreateEditorExtensionsOptions & {
  editable?: boolean;
  autofocus?: EditorOptions["autofocus"];
  editorProps?: EditorOptions["editorProps"];
};

const lowlight = createLowlight(common);

/**
 * Visually distinct Ink & Jade cursor colors for multi-user collaboration.
 * CollaborationCaret writes these into inline CSS properties, where custom
 * property references remain valid; keeping them unresolved also makes the
 * design-token package the only palette source.
 */
const CURSOR_COLORS = [
  "var(--color-collab-cursor-1)",
  "var(--color-collab-cursor-2)",
  "var(--color-collab-cursor-3)",
  "var(--color-collab-cursor-4)",
  "var(--color-collab-cursor-5)",
] as const;

const DEFAULT_USER: EditorUser = {
  name: "Meridian Researcher",
  color: CURSOR_COLORS[4],
};

export const COLLABORATION_Y_UNDO_TRACKED_ORIGINS = [
  REVIEW_APPLY_ORIGIN,
  REVIEW_DISCARD_ORIGIN,
] as const;

/** Pick the first palette color not already claimed by another connected client. */
function pickCursorColor(awareness: Awareness): string {
  const taken = new Set<string>();
  for (const [clientID, state] of awareness.getStates()) {
    if (clientID !== awareness.clientID && state.user?.color) {
      taken.add(state.user.color as string);
    }
  }
  return CURSOR_COLORS.find((c) => !taken.has(c)) ?? CURSOR_COLORS[0];
}

const STARTER_KIT_YJS_SAFETY_OPTIONS = {
  dropcursor: false,
  gapcursor: false,
  link: false,
  listKeymap: false,
  trailingNode: false,
  underline: false,
  undoRedo: false,
} as const;

const DOCUMENT_STARTER_KIT_OPTIONS = {
  ...STARTER_KIT_YJS_SAFETY_OPTIONS,
  // Schema names diverge from the server for these built-ins, so Meridian
  // installs snake_case/parity wrappers below instead.
  bold: false,
  bulletList: false,
  code: false,
  codeBlock: false,
  hardBreak: false,
  horizontalRule: false,
  italic: false,
  listItem: false,
  orderedList: false,
} as const;

const CODE_STARTER_KIT_OPTIONS = {
  ...DOCUMENT_STARTER_KIT_OPTIONS,
  blockquote: false,
  document: false,
  heading: false,
  paragraph: false,
} as const;

const CodeDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "code_block",
});

function createCollaborationExtensions({
  document,
  awareness,
  cursorProvider,
  user,
  showCollaborationDecorations = true,
}: Pick<
  CreateEditorExtensionsOptions,
  "document" | "awareness" | "cursorProvider" | "user" | "showCollaborationDecorations"
>): Extensions {
  const provider = cursorProvider ?? { awareness };
  const resolvedUser: EditorUser = {
    name: (user ?? DEFAULT_USER).name,
    color: pickCursorColor(provider.awareness),
  };

  const collaboration = [
    Collaboration.configure({
      document,
      // Passing the concrete Y.XmlFragment keeps the shared type name at the
      // server contract value (`prosemirror`).
      fragment: document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
      // y-tiptap always tracks ProseMirror typing (`ySyncPluginKey`) and augments
      // that default with this list. The review UndoManager is session-local: text-level
      // review apply/discard can use browser undo, while container-level disposition
      // routes to the server discard path and this manager is destroyed with the editor.
      yUndoOptions: { trackedOrigins: [...COLLABORATION_Y_UNDO_TRACKED_ORIGINS] },
    }),
  ];

  if (!showCollaborationDecorations) return collaboration;

  return [
    ...collaboration,
    CollaborationCaret.configure({
      provider,
      user: resolvedUser,
      render: (cursorUser) => {
        const cursor = window.document.createElement("span");
        cursor.classList.add("meridian-collab-cursor");
        cursor.style.borderColor = String(cursorUser.color ?? DEFAULT_USER.color);

        const label = window.document.createElement("span");
        label.classList.add("meridian-collab-cursor__label");
        label.style.backgroundColor = String(cursorUser.color ?? DEFAULT_USER.color);
        label.textContent = String(cursorUser.name ?? DEFAULT_USER.name);

        cursor.append(label);
        return cursor;
      },
      selectionRender: (cursorUser) => ({
        nodeName: "span",
        class: "meridian-collab-selection",
        style: `background-color: ${String(cursorUser.color ?? DEFAULT_USER.color)}`,
      }),
    }),
  ];
}

export function createEditorExtensions({
  document,
  awareness,
  schemaType = "document",
  cursorProvider,
  user = DEFAULT_USER,
  figureRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview = false,
}: CreateEditorExtensionsOptions): Extensions {
  const collaboration = createCollaborationExtensions({
    document,
    awareness,
    cursorProvider,
    user,
    showCollaborationDecorations,
  });

  return [
    ...createStandaloneEditorExtensions({ schemaType, figureRenderContext }),
    ...collaboration,
    ...(enableDraftInlineReview ? [DraftInlineReviewExtension] : []),
  ];
}

/** Meridian's canonical editor schema without transport or shared state. */
export function createStandaloneEditorExtensions({
  schemaType = "document",
  figureRenderContext,
}: Pick<CreateEditorExtensionsOptions, "schemaType" | "figureRenderContext"> = {}): Extensions {
  if (schemaType === "code") {
    return [
      StarterKit.configure(CODE_STARTER_KIT_OPTIONS),
      CodeDocument,
      MeridianCodeBlockLowlight.configure({ lowlight }),
    ];
  }
  return [
    StarterKit.configure(DOCUMENT_STARTER_KIT_OPTIONS),
    MeridianStrong,
    MeridianEm,
    MeridianCode,
    MeridianLink,
    MeridianBulletList,
    MeridianOrderedList,
    MeridianListItem,
    MeridianHardBreak,
    MeridianHorizontalRule,
    MeridianTable,
    MeridianTableRow,
    MeridianTableHeader,
    MeridianTableCell,
    MeridianCodeBlockLowlight.configure({ lowlight }),
    MeridianImage,
    MeridianJsxLeaf,
    MeridianJsxContainer,
    MeridianFigure.configure({
      projectId: figureRenderContext?.projectId,
      documentId: figureRenderContext?.documentId,
    }),
    LiveRangeNavigationExtension,
  ];
}

export function createEditorConfig({
  document,
  awareness,
  schemaType,
  cursorProvider,
  user,
  figureRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview,
  editable = true,
  autofocus = false,
  editorProps,
}: CreateEditorConfigOptions): Partial<EditorOptions> {
  const resolvedSchemaType = schemaType ?? "document";
  const resolvedEditorProps =
    resolvedSchemaType === "document"
      ? { clipboardTextParser: markdownTableClipboardParser(), ...editorProps }
      : editorProps;

  return {
    extensions: createEditorExtensions({
      document,
      awareness,
      schemaType: resolvedSchemaType,
      cursorProvider,
      user,
      figureRenderContext,
      showCollaborationDecorations,
      enableDraftInlineReview,
    }),
    editable,
    autofocus,
    ...(resolvedEditorProps ? { editorProps: resolvedEditorProps } : {}),
  };
}
