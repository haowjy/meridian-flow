/**
 * editor config — assembles the TipTap editor option set for a document session.
 *
 * Wires the Meridian node/mark extensions, collaboration (Yjs `Y.Doc` +
 * awareness/cursor) and math/code-highlight extensions into a `createEditorConfig`
 * factory, plus the `EditorUser` type and a sample document. Owns editor wiring,
 * not the session lifecycle (see `document-session.ts`).
 */

import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { type EditorOptions, type Extensions, Node } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import Mathematics from "@tiptap/extension-mathematics";
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
      // TipTap v2 calls this option `fragment`; passing the concrete
      // Y.XmlFragment keeps the shared type name at the server contract
      // value (`prosemirror`).
      fragment: document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    }),
  ];

  if (!showCollaborationDecorations) return collaboration;

  return [
    ...collaboration,
    CollaborationCursor.configure({
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
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        document: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        history: false,
        horizontalRule: false,
        italic: false,
        listItem: false,
        orderedList: false,
        paragraph: false,
        strike: false,
      }),
      CodeDocument,
      MeridianCodeBlockLowlight.configure({ lowlight }),
      ...collaboration,
    ];
  }

  return [
    StarterKit.configure({
      // Schema names diverge from the server for these built-ins, so Meridian
      // installs snake_case/parity wrappers below instead.
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      hardBreak: false,
      history: false,
      horizontalRule: false,
      italic: false,
      listItem: false,
      orderedList: false,
      strike: false,
    }),
    MeridianStrong,
    MeridianEm,
    MeridianCode,
    MeridianLink,
    MeridianBulletList,
    MeridianOrderedList,
    MeridianListItem,
    MeridianHardBreak,
    MeridianCodeBlockLowlight.configure({ lowlight }),
    Mathematics,
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
    editorProps,
  };
}
