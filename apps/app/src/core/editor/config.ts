/**
 * editor config — assembles the TipTap editor option set for a document session.
 *
 * Wires the Meridian node/mark extensions, collaboration (the Loro binding on the session's
 * copy, peer carets) and code-highlight extensions into a `createEditorConfig`
 * factory, plus the `EditorUser` type and a sample document. Owns editor wiring,
 * not the session lifecycle (see `document-session.ts`).
 */

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

/**
 * Who this client is, published with its caret: a peer on the same account labels it "You".
 * No name yet: every peer today is the writer's own tab or device.
 */
export type EditorUser = {
  accountId: string;
};

/** Project whose asset namespace resolves `asset:<documentId>` image sources. */
export type AssetRenderContext = {
  projectId?: string;
  /** The draft id the viewer reads: a picture still pending in its draft is signed through it. */
  owner?: string;
};

/** The copy an editor shows and writes: its docs, and the one path its writes leave by. */
export type EditorCopy = {
  docs: RoomDocs;
  publish: (changes: readonly DocChange[]) => void;
};

export type CreateEditorExtensionsOptions = {
  copy: EditorCopy;
  /** The document's undo, owned by its session; this editor attaches while mounted. */
  history: DocumentHistory;
  schemaType?: TrackedSchemaType;
  /**
   * A code document's filetype, which is its fence's language: it paints the fence, and the
   * fence an empty file is filled with stores it, as the one the server writes does.
   */
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
  /** Render remote cursor/selection decorations from awareness. */
  showCollaborationDecorations?: boolean;
  /** Mounts the slash insertion menu; omitted surfaces never pay for it. */
  slashCommands?: SlashCommandExtensionOptions;
  atReferences?: AtReferenceExtensionOptions;
  /** Turns project-tree rows into the same references `@` writes. */
  referenceDrop?: ReferenceDropOptions;
  /** Turns a pasted `[[Name]]` into a link; only the Editor mounts it. */
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

/**
 * What a code file's fence is painted with: its filetype, whatever `language` the block stores,
 * so a rename to another type repaints and a file stored with no or another language reads as
 * its type. A filetype lowlight doesn't know is detected from the text.
 */
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
 * Order is precedence. The kernel comes first because it resolves the context
 * everything below reads; object physics next because it is the deepest thing
 * in the document. Above all of it, unlisted, sits `UndoRedoKeymapExtension`
 * at TipTap priority 1100 — undo is the writer's recovery over LLM
 * writes and no surface may shadow it.
 */
const EDITOR_CHROME_EXTENSIONS: Extensions = [
  ChromeKernelExtension,
  ObjectPhysicsExtension,
  // Not lanes: the editor's own Tab and the cell's own Enter. Both need the
  // kernel's registry to reach a scope, so they mount exactly where it does.
  TabKeymapExtension,
  TableEnterKeymapExtension,
  // L-A formatting menu (M4)
  // L-B object controls + diagram (M5)
  // L-C table chrome (M6)
  // L-D slash (M8) mounts with the catalog option instead: a surface that
  // passes no catalog pays for no trigger.
  BlockDragExtension, // L-E block movement (M9)
  LinkSurfaceExtension, // L-F links (M7)
];

/** Pick the first palette color not already claimed by another connected client. */
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
  // Off for a different reason than the rest of this list: the stock
  // dropcursor computes its own landing. `LandingExtension` draws the one
  // caret (jade, matching the block drag's drop line) from the plan it lands.
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
  // Schema names diverge from the server for these built-ins, so Meridian
  // installs snake_case/parity wrappers below instead. A quote is not a node:
  // `NestingExtension` owns it.
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
    // Mounted history records the binding's writes, so its key bindings mount with it
    // rather than in the standalone set.
    UndoRedoKeymapExtension.configure({ history }),
    // Text kept in place: a paragraph deleted under the caret, an edit Undo left.
    KeptExtension.configure({ presence }),
    // A document with no shared room has no "uploading elsewhere", so the
    // ephemeral half of uploads mounts here rather than beside the doors.
    ...(schemaType === "document" ? [UploadPresenceExtension.configure({ presence })] : []),
  ];
}

/** Meridian's canonical editor schema without transport or shared state. */
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
      // A code file is one fence, so the fence's bracket/quote set is the
      // whole document's.
      AutoPairExtension,
      // Text drags only: the same caret and landing the document shows.
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
    // Below the autoformat, which owns the delimiters this deliberately does
    // not pair (`**`, `__`, `~~`, and the backtick outside a fence).
    AutoPairExtension,
    PassageHighlightExtension,
    // Review changes' paint on a draft page; inert until its host turns it on.
    ReviewChangesExtension,
    // The one door a picture comes in through — picker, drop, pasted file,
    // pasted address — and the owner of the clipboard's asset translation,
    // which is why the markdown text parser is its prop rather than a
    // view-level default here (a view prop would shadow the plugin's).
    ImageIngressExtension,
    // Where a dropped file that is not a picture goes, and who takes its upload back.
    FileDropExtension,
    // Where dragged content lands, and the caret that promises it. The lanes
    // that know a payload (rows, files) hand it their doors here, so the
    // landing imports neither.
    LandingExtension.configure({
      entries: referenceDrop && referenceDropDoor(referenceDrop),
      files: fileDropDoor,
    }),
    // Chrome mounts only on the document schema: a code file is one code
    // block with no objects and no surfaces to own.
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
    // The binding's rule: the editor starts as the docs read.
    content: roomContent(copy.docs).toJSON(),
    editable,
    autofocus,
    editorProps: sanitizedEditorProps,
  };
}
