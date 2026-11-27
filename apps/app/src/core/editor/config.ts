import type { Filetype, TrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocChange, RoomDocs } from "@meridian/document-model";
import { type EditorOptions, type Extensions, Node } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { BlockDragExtension } from "./blocks";
import { ChromeKernelExtension } from "./chrome";
import { COLLABORATION_CURSOR_COLORS, resolveCollaborationColor } from "./collaboration-colors";
import type { DocumentHistory } from "./editor-history";
import { AtReferenceExtension, type AtReferenceExtensionOptions } from "./extensions/at-reference";
import { AutoPairExtension } from "./extensions/auto-pair";
import { BlockIdExtension } from "./extensions/block-id";
import { CommentMark } from "./extensions/CommentMark";
import { KeptExtension } from "./extensions/KeptExtension";
import { LoroSyncExtension } from "./extensions/loro-sync";
import { MarkdownAutoformatExtension } from "./extensions/MarkdownAutoformatExtension";
import {
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
  MeridianParagraph,
  MeridianStrong,
  MeridianTable,
  MeridianTableCell,
  MeridianTableHeader,
  MeridianTableRow,
} from "./extensions/meridian-extensions";
import { NestingExtension } from "./extensions/nesting";
import { PassageHighlightExtension } from "./extensions/PassageHighlightExtension";
import { PeerCarets } from "./extensions/peer-carets";
import { type ReferenceDropOptions, referenceDropDoor } from "./extensions/reference-drop";
import { ReviewChangesExtension } from "./extensions/review-changes/ReviewChangesExtension";
import { SlashCommandExtension, type SlashCommandExtensionOptions } from "./extensions/slash";
import { TabKeymapExtension } from "./extensions/TabKeymapExtension";
import { TableEnterKeymapExtension } from "./extensions/TableEnterKeymapExtension";
import { UndoRedoKeymapExtension } from "./extensions/UndoRedoKeymapExtension";
import { FileDropExtension, fileDropDoor } from "./file-drop";
import { ImageIngressExtension } from "./images";
import { LandingExtension } from "./landing/LandingExtension";
import { LinkSurfaceExtension, WikilinkPasteExtension, type WikilinkPasteOptions } from "./links";
import type { LocalPresenceFields, PeerAwareness } from "./local-presence";
import { ObjectPhysicsExtension } from "./objects";
import { roomContent } from "./room-content";
import { sanitizePastedHTML } from "./sanitize-paste";
import { editorSuggestionHost } from "./suggestion-host";
import { UploadPresenceExtension } from "./upload-presence";

export type EditorUser = {
  accountId: string;
};

export type AssetRenderContext = {
  projectId?: string;
  owner?: string;
};

export type EditorCopy = {
  docs: RoomDocs;
  publish: (changes: readonly DocChange[]) => void;
};

export type CreateEditorExtensionsOptions = {
  copy: EditorCopy;
  history: DocumentHistory;
  schemaType?: TrackedSchemaType;
  filetype?: Filetype;
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
  showCollaborationDecorations?: boolean;
  slashCommands?: SlashCommandExtensionOptions;
  atReferences?: AtReferenceExtensionOptions;
  referenceDrop?: ReferenceDropOptions;
  wikilinkPaste?: WikilinkPasteOptions;
};

export type CreateEditorConfigOptions = CreateEditorExtensionsOptions & {
  editable?: boolean;
  autofocus?: EditorOptions["autofocus"];
  placeholder?: string;
  editorProps?: EditorOptions["editorProps"];
};

const lowlight = createLowlight(common);

/**
 * The lowlight grammar a filetype paints with, where its name differs: lowlight's `shell` is a
 * terminal session (`#` is a prompt), and CSV has no grammar, so it would be detected as code.
 */
const GRAMMAR_FOR_FILETYPE: Partial<Record<Filetype, string>> = {
  shell: "bash",
  csv: "plaintext",
};

function lowlightAs(filetype: Filetype | undefined): typeof lowlight {
  const grammar = filetype && (GRAMMAR_FOR_FILETYPE[filetype] ?? filetype);
  if (!grammar || !lowlight.registered(grammar)) return lowlight;
  const paint = (value: string) => lowlight.highlight(grammar, value);
  return { ...lowlight, highlight: (_language, value) => paint(value), highlightAuto: paint };
}

/**
 * Chrome extension registration list — the append-only seam every surface
 * lane touches.
 *
 * One line per lane, in this order, and nothing else: a surface's behavior
 * lives in its own module and reaches the editor through the kernel's
 * registries (`getEditorChrome`, `registerObjectEngagement`), not through a
 * new configuration knob here.
 *
 * Order is precedence; the lanes that must outrank the rest, and undo above
 * them all, take their priority from `EXTENSION_PRIORITY`.
 */
const EDITOR_CHROME_EXTENSIONS: Extensions = [
  ChromeKernelExtension,
  ObjectPhysicsExtension,
  TabKeymapExtension,
  TableEnterKeymapExtension,
  BlockDragExtension,
  LinkSurfaceExtension,
];

function pickCursorColor(peers: PeerAwareness): string {
  const taken = new Set<string>();
  for (const [clientID, state] of peers.getStates()) {
    const color = (state.user as { color?: unknown } | undefined)?.color;
    if (clientID !== peers.clientID && typeof color === "string") taken.add(color);
  }
  const palette = COLLABORATION_CURSOR_COLORS.map(resolveCollaborationColor);
  return palette.find((color) => !taken.has(color)) ?? palette[0];
}

const STARTER_KIT_COLLAB_SAFETY_OPTIONS = {
  dropcursor: false,
  // Gapcursor is deliberately ABSENT from this list (absent = enabled): it is
  // display-only (no schema or wire impact) and it is the caret's only way
  // BELOW a trailing table (a click below it, ArrowDown out of its last cell,
  // Ctrl/Cmd+End) — without it a writer can reach the document end
  // and never type again (the trailing-table trap). The rest of this list is
  // off for collaboration or schema-parity reasons; gapcursor never was, it had been
  // swept up with them.
  link: false,
  listKeymap: false,
  trailingNode: false,
  underline: false,
  undoRedo: false,
} as const;

const DOCUMENT_STARTER_KIT_OPTIONS = {
  ...STARTER_KIT_COLLAB_SAFETY_OPTIONS,
  blockquote: false,
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
  document: false,
} as const;

const CodeDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "code_block",

  // The only block is the whole document, so no selection belongs at the doc
  // level: Ctrl+A would make paste split into paragraphs (a code-only doc keeps
  // the first) and typing replace the block, dropping its language and id.
  // Select-all becomes the text of the block instead. Tiptap's clearDocument
  // resets the block to defaults when the whole text goes, and a default
  // block has a new id, so every edit opts out of it.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction) {
          transaction.setMeta("preventClearDocument", true);
          return true;
        },
        appendTransaction(_trs, _old, state) {
          const { $from, $to } = state.selection;
          if ($from.depth > 0 && $to.depth > 0) return null;
          return state.tr.setSelection(
            TextSelection.create(state.doc, 1, state.doc.content.size - 1),
          );
        },
      }),
    ];
  },
});

function createCollaborationExtensions({
  copy,
  history,
  presence,
  user,
  showCollaborationDecorations = true,
}: Pick<
  CreateEditorExtensionsOptions,
  "copy" | "history" | "presence" | "user" | "showCollaborationDecorations"
>): Extensions {
  const sync = LoroSyncExtension.configure({ copy, history });
  if (!showCollaborationDecorations) return [sync];
  return [
    sync,
    PeerCarets.configure({
      docs: copy.docs,
      presence,
      user: { accountId: user?.accountId ?? "", color: pickCursorColor(presence.peers) },
    }),
  ];
}

export function createEditorExtensions({
  copy,
  history,
  schemaType = "document",
  filetype,
  presence,
  user,
  assetRenderContext,
  showCollaborationDecorations,
  slashCommands,
  atReferences,
  referenceDrop,
  wikilinkPaste,
}: CreateEditorExtensionsOptions): Extensions {
  const collaboration = createCollaborationExtensions({
    copy,
    history,
    presence,
    user,
    showCollaborationDecorations,
  });

  return [
    ...createStandaloneEditorExtensions({
      schemaType,
      filetype,
      assetRenderContext,
      slashCommands,
      atReferences,
      referenceDrop,
      wikilinkPaste,
    }),
    ...collaboration,
    UndoRedoKeymapExtension.configure({ history }),
    KeptExtension,
    ...(schemaType === "document" ? [UploadPresenceExtension.configure({ presence })] : []),
  ];
}

export function createStandaloneEditorExtensions({
  schemaType = "document",
  filetype,
  assetRenderContext,
  slashCommands,
  atReferences,
  referenceDrop,
  wikilinkPaste,
}: Pick<
  CreateEditorExtensionsOptions,
  | "schemaType"
  | "filetype"
  | "assetRenderContext"
  | "slashCommands"
  | "atReferences"
  | "referenceDrop"
  | "wikilinkPaste"
> = {}): Extensions {
  if (schemaType === "code") {
    return [
      StarterKit.configure(CODE_STARTER_KIT_OPTIONS),
      CodeDocument,
      BlockIdExtension,
      MeridianCodeBlockLowlight.configure({
        lowlight: lowlightAs(filetype),
        defaultLanguage: filetype ?? null,
      }),
      AutoPairExtension,
      LandingExtension,
    ];
  }
  return [
    StarterKit.configure(DOCUMENT_STARTER_KIT_OPTIONS),
    MeridianStrong,
    MeridianEm,
    MeridianCode,
    MeridianLink,
    BlockIdExtension,
    NestingExtension,
    CommentMark,
    MeridianHardBreak,
    MeridianHorizontalRule,
    MeridianParagraph,
    MeridianTable,
    MeridianTableRow,
    MeridianTableHeader,
    MeridianTableCell,
    MeridianCodeBlockLowlight.configure({ lowlight }),
    MeridianImage.configure({
      projectId: assetRenderContext?.projectId,
      owner: assetRenderContext?.owner,
    }),
    MeridianJsxLeaf,
    MeridianJsxContainer,
    MeridianFigure.configure({
      projectId: assetRenderContext?.projectId,
      owner: assetRenderContext?.owner,
    }),
    ...(slashCommands
      ? [
          SlashCommandExtension.configure({
            ...slashCommands,
            suggestionHost: (editor) => editorSuggestionHost(editor, "prose"),
          }),
        ]
      : []),
    ...(atReferences
      ? [
          AtReferenceExtension.configure({
            ...atReferences,
            suggestionHost: (editor) => editorSuggestionHost(editor, "prose"),
          }),
        ]
      : []),
    ...(wikilinkPaste ? [WikilinkPasteExtension.configure(wikilinkPaste)] : []),
    MarkdownAutoformatExtension,
    AutoPairExtension,
    PassageHighlightExtension,
    ReviewChangesExtension,
    // The one door a picture comes in through — picker, drop, pasted file,
    // pasted address — and the owner of the clipboard's asset translation,
    // which is why the markdown text parser is its prop rather than a
    // view-level default here (a view prop would shadow the plugin's).
    ImageIngressExtension,
    FileDropExtension,
    LandingExtension.configure({
      entries: referenceDrop && referenceDropDoor(referenceDrop),
      files: fileDropDoor,
    }),
    ...EDITOR_CHROME_EXTENSIONS,
  ];
}

export function createEditorConfig({
  copy,
  history,
  schemaType,
  filetype,
  presence,
  user,
  assetRenderContext,
  showCollaborationDecorations,
  slashCommands,
  atReferences,
  referenceDrop,
  wikilinkPaste,
  editable = true,
  autofocus = false,
  placeholder,
  editorProps,
}: CreateEditorConfigOptions): Partial<EditorOptions> {
  const resolvedSchemaType = schemaType ?? "document";
  const callerTransformPastedHTML = editorProps?.transformPastedHTML;
  const sanitizedEditorProps = {
    ...editorProps,
    transformPastedHTML: (html: string, view: EditorView) =>
      sanitizePastedHTML(callerTransformPastedHTML ? callerTransformPastedHTML(html, view) : html),
  };

  return {
    extensions: [
      ...createEditorExtensions({
        copy,
        history,
        schemaType: resolvedSchemaType,
        filetype,
        presence,
        user,
        assetRenderContext,
        showCollaborationDecorations,
        slashCommands,
        atReferences,
        referenceDrop,
        wikilinkPaste,
      }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ],
    content: roomContent(copy.docs).toJSON(),
    editable,
    autofocus,
    editorProps: sanitizedEditorProps,
  };
}
