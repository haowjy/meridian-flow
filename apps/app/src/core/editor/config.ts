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
import Placeholder from "@tiptap/extension-placeholder";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { AgentNameStore } from "./agent-name-store";
import { COLLABORATION_CURSOR_COLORS, resolveCollaborationColor } from "./collaboration-colors";
import { DraftInlineReviewExtension } from "./extensions/inline-review";
import { LiveRangeNavigationExtension } from "./extensions/LiveRangeNavigationExtension";
import { MarkdownAutoformatExtension } from "./extensions/MarkdownAutoformatExtension";
import {
  MeridianBulletList,
  MeridianCode,
  MeridianCodeBlockLowlight,
  MeridianEm,
  MeridianFigure,
  MeridianHardBreak,
  MeridianHeading,
  MeridianHorizontalRule,
  MeridianImage,
  MeridianJsxContainer,
  MeridianJsxLeaf,
  MeridianLink,
  MeridianListItem,
  MeridianOrderedList,
  MeridianParagraph,
  MeridianStrong,
  MeridianTable,
  MeridianTableCell,
  MeridianTableHeader,
  MeridianTableRow,
} from "./extensions/meridian-extensions";
import { PassageHighlightExtension } from "./extensions/PassageHighlightExtension";
import { PeerMarkerExtension } from "./extensions/PeerMarkerExtension";
import {
  SlashCommandExtension,
  type SlashCommandExtensionOptions,
} from "./extensions/SlashCommandExtension";
import { UndoRedoKeymapExtension } from "./extensions/UndoRedoKeymapExtension";
import { markdownTableClipboardParser } from "./markdown-paste";
import { sanitizePastedHTML } from "./sanitize-paste";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import type { SessionMarkerStore } from "./session-marker-store";

export type EditorUser = {
  name: string;
  color: string;
};

export type AwarenessProvider = {
  awareness: Awareness;
};

/** Project whose asset namespace resolves `asset:<documentId>` image sources. */
export type AssetRenderContext = {
  projectId?: string;
};

export type CreateEditorExtensionsOptions = {
  document: Y.Doc;
  awareness: Awareness;
  schemaType?: YjsTrackedSchemaType;
  cursorProvider?: AwarenessProvider;
  user?: EditorUser;
  assetRenderContext?: AssetRenderContext;
  /** Render remote cursor/selection decorations from awareness. */
  showCollaborationDecorations?: boolean;
  /**
   * Mount the DraftInlineReviewExtension when the editor is bound to a draft
   * room. Live editors omit this flag so they never pay the extra plugin cost.
   */
  enableDraftInlineReview?: boolean;
  /** Live-session sidecar; omitted for branch/draft rooms. */
  markerStore?: SessionMarkerStore;
  /** Writer-facing thread names for agent-authored session marks. */
  agentNames?: AgentNameStore;
  /** Mounts the slash insertion menu; omitted surfaces never pay for it. */
  slashCommands?: SlashCommandExtensionOptions;
};

export type CreateEditorConfigOptions = CreateEditorExtensionsOptions & {
  editable?: boolean;
  autofocus?: EditorOptions["autofocus"];
  placeholder?: string;
  editorProps?: EditorOptions["editorProps"];
};

const lowlight = createLowlight(common);

/**
 * Collaboration cursor default. The composition path resolves its token before
 * publishing awareness because y-prosemirror accepts concrete colors only.
 */
const DEFAULT_USER: EditorUser = {
  name: "Meridian Researcher",
  color: COLLABORATION_CURSOR_COLORS[4],
};

/** Pick the first palette color not already claimed by another connected client. */
function pickCursorColor(awareness: Awareness): string {
  const taken = new Set<string>();
  for (const [clientID, state] of awareness.getStates()) {
    if (clientID !== awareness.clientID && state.user?.color) {
      taken.add(state.user.color as string);
    }
  }
  const palette = COLLABORATION_CURSOR_COLORS.map(resolveCollaborationColor);
  return palette.find((color) => !taken.has(color)) ?? palette[0];
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
  heading: false,
  horizontalRule: false,
  italic: false,
  listItem: false,
  orderedList: false,
  paragraph: false,
} as const;

const CODE_STARTER_KIT_OPTIONS = {
  ...DOCUMENT_STARTER_KIT_OPTIONS,
  blockquote: false,
  document: false,
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
  assetRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview = false,
  markerStore,
  agentNames,
  slashCommands,
}: CreateEditorExtensionsOptions): Extensions {
  const collaboration = createCollaborationExtensions({
    document,
    awareness,
    cursorProvider,
    user,
    showCollaborationDecorations,
  });

  return [
    ...createStandaloneEditorExtensions({ schemaType, assetRenderContext, slashCommands }),
    ...collaboration,
    // Undo exists only alongside collaboration's UndoManager, so its owned key
    // bindings mount with it rather than in the standalone set.
    UndoRedoKeymapExtension,
    ...(markerStore ? [PeerMarkerExtension.configure({ markerStore, agentNames })] : []),
    ...(enableDraftInlineReview ? [DraftInlineReviewExtension] : []),
  ];
}

/** Meridian's canonical editor schema without transport or shared state. */
export function createStandaloneEditorExtensions({
  schemaType = "document",
  assetRenderContext,
  slashCommands,
}: Pick<
  CreateEditorExtensionsOptions,
  "schemaType" | "assetRenderContext" | "slashCommands"
> = {}): Extensions {
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
    MeridianParagraph,
    MeridianHeading,
    MeridianTable,
    MeridianTableRow,
    MeridianTableHeader,
    MeridianTableCell,
    MeridianCodeBlockLowlight.configure({ lowlight }),
    MeridianImage.configure({ projectId: assetRenderContext?.projectId }),
    MeridianJsxLeaf,
    MeridianJsxContainer,
    MeridianFigure.configure({
      projectId: assetRenderContext?.projectId,
    }),
    ...(slashCommands ? [SlashCommandExtension.configure(slashCommands)] : []),
    MarkdownAutoformatExtension,
    LiveRangeNavigationExtension,
    PassageHighlightExtension,
  ];
}

export function createEditorConfig({
  document,
  awareness,
  schemaType,
  cursorProvider,
  user,
  assetRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview,
  markerStore,
  agentNames,
  slashCommands,
  editable = true,
  autofocus = false,
  placeholder,
  editorProps,
}: CreateEditorConfigOptions): Partial<EditorOptions> {
  const resolvedSchemaType = schemaType ?? "document";
  // Sanitization runs last so a caller transform can never reintroduce markup
  // the schema would otherwise accept.
  const callerTransformPastedHTML = editorProps?.transformPastedHTML;
  const sanitizedEditorProps = {
    ...editorProps,
    transformPastedHTML: (html: string, view: EditorView) =>
      sanitizePastedHTML(callerTransformPastedHTML ? callerTransformPastedHTML(html, view) : html),
  };
  const resolvedEditorProps =
    resolvedSchemaType === "document"
      ? { clipboardTextParser: markdownTableClipboardParser(), ...sanitizedEditorProps }
      : sanitizedEditorProps;

  return {
    extensions: [
      ...createEditorExtensions({
        document,
        awareness,
        schemaType: resolvedSchemaType,
        cursorProvider,
        user,
        assetRenderContext,
        showCollaborationDecorations,
        enableDraftInlineReview,
        markerStore,
        agentNames,
        slashCommands,
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ],
    editable,
    autofocus,
    ...(resolvedEditorProps ? { editorProps: resolvedEditorProps } : {}),
  };
}
