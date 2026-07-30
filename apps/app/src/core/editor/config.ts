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
import type * as Y from "yjs";
import type { AgentNameStore } from "./agent-name-store";
import { BlockDragExtension } from "./blocks";
import { ChromeKernelExtension } from "./chrome";
import { COLLABORATION_CURSOR_COLORS, resolveCollaborationColor } from "./collaboration-colors";
import { AutoPairExtension } from "./extensions/auto-pair";
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
import { SlashCommandExtension, type SlashCommandExtensionOptions } from "./extensions/slash";
import { TabKeymapExtension } from "./extensions/TabKeymapExtension";
import { UndoRedoKeymapExtension } from "./extensions/UndoRedoKeymapExtension";
import { type WikilinkExtensionOptions, WikilinkSuggestionExtension } from "./extensions/wikilink";
import { ImageIngressExtension, ImageUploadPresenceExtension } from "./images";
import { LinkSurfaceExtension } from "./links";
import type { LocalPresenceFields, PeerAwareness } from "./local-presence";
import { ObjectPhysicsExtension } from "./objects";
import { sanitizePastedHTML } from "./sanitize-paste";
import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";
import type { SessionMarkerStore } from "./session-marker-store";

export type EditorUser = {
  name: string;
  color: string;
};

/** Project whose asset namespace resolves `asset:<documentId>` image sources. */
export type AssetRenderContext = {
  projectId?: string;
};

export type CreateEditorExtensionsOptions = {
  document: Y.Doc;
  schemaType?: YjsTrackedSchemaType;
  /**
   * This client's presence, held by whatever decides when it is on the wire —
   * normally the `DocumentSession`'s (`local-presence.ts`).
   *
   * The editor's only reach into awareness, deliberately. The caret's provider,
   * the peer list a cursor color is picked against, and the image-upload
   * announcement all come from here, so nothing assembled below can publish a
   * local field the session cannot suspend.
   */
  presence: LocalPresenceFields;
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
  /** Mounts the `[[` document menu; a surface with no project offers none. */
  wikilinks?: WikilinkExtensionOptions;
};

export type CreateEditorConfigOptions = CreateEditorExtensionsOptions & {
  editable?: boolean;
  autofocus?: EditorOptions["autofocus"];
  placeholder?: string;
  editorProps?: EditorOptions["editorProps"];
};

const lowlight = createLowlight(common);

/**
 * Chrome extension registration list — the append-only seam every surface
 * lane touches.
 *
 * One line per lane, in this order, and nothing else: a surface's behavior
 * lives in its own module and reaches the editor through the kernel's
 * registries (`getEditorChrome`, `registerObjectEngagement`), not through a
 * new configuration knob here.
 *
 * Order is precedence. The kernel comes first because it resolves the context
 * everything below reads; object physics next because it is the deepest thing
 * in the document. Above all of it, unlisted, sits `UndoRedoKeymapExtension`
 * at TipTap priority 1100 (ruling 17) — undo is the writer's recovery over LLM
 * writes and no surface may shadow it.
 */
const EDITOR_CHROME_EXTENSIONS: Extensions = [
  ChromeKernelExtension,
  ObjectPhysicsExtension,
  // Not a lane: the editor's own Tab. It needs the kernel's registry to sit
  // at two scopes at once, so it mounts exactly where the kernel does.
  TabKeymapExtension,
  // L-A formatting menu (M4)
  // L-B object controls + diagram (M5)
  // L-C table chrome (M6)
  // L-D slash (M8) mounts with the catalog option instead: a surface that
  // passes no catalog pays for no trigger.
  BlockDragExtension, // L-E block movement (M9)
  LinkSurfaceExtension, // L-F links (M7)
];

/**
 * Collaboration cursor default. The composition path resolves its token before
 * publishing awareness because y-prosemirror accepts concrete colors only.
 */
const DEFAULT_USER: EditorUser = {
  name: "Meridian Researcher",
  color: COLLABORATION_CURSOR_COLORS[4],
};

/** Pick the first palette color not already claimed by another connected client. */
function pickCursorColor(peers: PeerAwareness): string {
  const taken = new Set<string>();
  for (const [clientID, state] of peers.getStates()) {
    if (clientID !== peers.clientID && state.user?.color) {
      taken.add(state.user.color as string);
    }
  }
  const palette = COLLABORATION_CURSOR_COLORS.map(resolveCollaborationColor);
  return palette.find((color) => !taken.has(color)) ?? palette[0];
}

const STARTER_KIT_YJS_SAFETY_OPTIONS = {
  // Dropcursor is display-only, like gapcursor below: it draws where dragged
  // text will land and touches neither schema nor wire. It had been swept
  // into this list with the real Yjs exclusions, which left a text drag with
  // no landing indicator at all. Jade, matching the block drag's drop line.
  dropcursor: { color: "var(--color-primary)", width: 2 },
  // Gapcursor is deliberately ABSENT from this list (absent = enabled): it is
  // display-only (no schema or wire impact) and it is the caret's only way
  // BELOW a trailing table — without it a writer can reach the document end
  // and never type again (the trailing-table trap). The rest of this list is
  // off for Yjs or schema-parity reasons; gapcursor never was, it had been
  // swept up with them.
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
  presence,
  user,
  showCollaborationDecorations = true,
}: Pick<
  CreateEditorExtensionsOptions,
  "document" | "presence" | "user" | "showCollaborationDecorations"
>): Extensions {
  const resolvedUser: EditorUser = {
    name: (user ?? DEFAULT_USER).name,
    color: pickCursorColor(presence.peers),
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
    // The presence owner's provider, never the bare Awareness: the caret and
    // y-prosemirror's cursor plugin write and clear `user`/`cursor` through it,
    // and a raw write made while the writer is hidden behind inline review is
    // dropped, then overwritten by the snapshot the review restores.
    CollaborationCaret.configure({
      provider: presence.caretProvider,
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
  schemaType = "document",
  presence,
  user = DEFAULT_USER,
  assetRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview = false,
  markerStore,
  agentNames,
  slashCommands,
  wikilinks,
}: CreateEditorExtensionsOptions): Extensions {
  const collaboration = createCollaborationExtensions({
    document,
    presence,
    user,
    showCollaborationDecorations,
  });

  return [
    ...createStandaloneEditorExtensions({
      schemaType,
      assetRenderContext,
      slashCommands,
      wikilinks,
    }),
    ...collaboration,
    // Undo exists only alongside collaboration's UndoManager, so its owned key
    // bindings mount with it rather than in the standalone set.
    UndoRedoKeymapExtension,
    // A document with no shared room has no "uploading elsewhere", so the
    // ephemeral half of image ingress mounts here rather than beside the door.
    ...(schemaType === "document" ? [ImageUploadPresenceExtension.configure({ presence })] : []),
    ...(markerStore ? [PeerMarkerExtension.configure({ markerStore, agentNames })] : []),
    ...(enableDraftInlineReview ? [DraftInlineReviewExtension] : []),
  ];
}

/** Meridian's canonical editor schema without transport or shared state. */
export function createStandaloneEditorExtensions({
  schemaType = "document",
  assetRenderContext,
  slashCommands,
  wikilinks,
}: Pick<
  CreateEditorExtensionsOptions,
  "schemaType" | "assetRenderContext" | "slashCommands" | "wikilinks"
> = {}): Extensions {
  if (schemaType === "code") {
    return [
      StarterKit.configure(CODE_STARTER_KIT_OPTIONS),
      CodeDocument,
      MeridianCodeBlockLowlight.configure({ lowlight }),
      // A code file is one fence, so the fence's bracket/quote set is the
      // whole document's.
      AutoPairExtension,
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
    ...(wikilinks ? [WikilinkSuggestionExtension.configure(wikilinks)] : []),
    MarkdownAutoformatExtension,
    // Below the autoformat, which owns the delimiters this deliberately does
    // not pair (`**`, `__`, `~~`, and the backtick outside a fence).
    AutoPairExtension,
    LiveRangeNavigationExtension,
    PassageHighlightExtension,
    // The one door a picture comes in through — picker, drop, pasted file,
    // pasted address — and the owner of the clipboard's asset translation,
    // which is why the markdown text parser is its prop rather than a
    // view-level default here (a view prop would shadow the plugin's).
    ImageIngressExtension,
    // Chrome mounts only on the document schema: a code file is one code
    // block with no objects and no surfaces to own.
    ...EDITOR_CHROME_EXTENSIONS,
  ];
}

export function createEditorConfig({
  document,
  schemaType,
  presence,
  user,
  assetRenderContext,
  showCollaborationDecorations,
  enableDraftInlineReview,
  markerStore,
  agentNames,
  slashCommands,
  wikilinks,
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

  return {
    extensions: [
      ...createEditorExtensions({
        document,
        schemaType: resolvedSchemaType,
        presence,
        user,
        assetRenderContext,
        showCollaborationDecorations,
        enableDraftInlineReview,
        markerStore,
        agentNames,
        slashCommands,
        wikilinks,
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ],
    editable,
    autofocus,
    editorProps: sanitizedEditorProps,
  };
}
