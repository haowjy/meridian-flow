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
import {
  MeridianBulletList,
  MeridianCode,
  MeridianCodeBlockLowlight,
  MeridianEm,
  MeridianFigure,
  MeridianHardBreak,
  MeridianHorizontalRule,
  MeridianImage,
  MeridianLink,
  MeridianListItem,
  MeridianMathDisplay,
  MeridianOrderedList,
  MeridianStrong,
  MeridianTable,
  MeridianTableCell,
  MeridianTableHeader,
  MeridianTableRow,
} from "./extensions/meridian-extensions";
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
};

export type CreateEditorConfigOptions = CreateEditorExtensionsOptions & {
  editable?: boolean;
  autofocus?: EditorOptions["autofocus"];
  editorProps?: EditorOptions["editorProps"];
};

const lowlight = createLowlight(common);

const DEFAULT_USER: EditorUser = {
  name: "Meridian Researcher",
  color: "var(--color-primary)",
};

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
  strike: false,
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

  const collaboration = [
    Collaboration.configure({
      document,
      // Passing the concrete Y.XmlFragment keeps the shared type name at the
      // server contract value (`prosemirror`).
      fragment: document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    }),
  ];

  if (!showCollaborationDecorations) return collaboration;

  return [
    ...collaboration,
    CollaborationCaret.configure({
      provider,
      user: user ?? DEFAULT_USER,
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
}: CreateEditorExtensionsOptions): Extensions {
  const collaboration = createCollaborationExtensions({
    document,
    awareness,
    cursorProvider,
    user,
    showCollaborationDecorations,
  });

  if (schemaType === "code") {
    return [
      StarterKit.configure(CODE_STARTER_KIT_OPTIONS),
      CodeDocument,
      MeridianCodeBlockLowlight.configure({ lowlight }),
      ...collaboration,
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
    MeridianCodeBlockLowlight.configure({ lowlight }),
    MeridianMathDisplay,
    MeridianTable,
    MeridianTableRow,
    MeridianTableCell,
    MeridianTableHeader,
    MeridianImage,
    MeridianFigure.configure({
      projectId: figureRenderContext?.projectId,
      documentId: figureRenderContext?.documentId,
    }),
    ...collaboration,
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
  editable = true,
  autofocus = false,
  editorProps,
}: CreateEditorConfigOptions): Partial<EditorOptions> {
  return {
    extensions: createEditorExtensions({
      document,
      awareness,
      schemaType,
      cursorProvider,
      user,
      figureRenderContext,
      showCollaborationDecorations,
    }),
    editable,
    autofocus,
    ...(editorProps ? { editorProps } : {}),
  };
}
