/** Defines document-toolbar state and commands. */

import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { HEADING_LEVELS, type HeadingLevel } from "@meridian/prosemirror-schema";
import type { Editor } from "@tiptap/core";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

import { type ChromeContext, chromeContextAt, resolveChromeContext } from "@/core/editor/chrome";
import {
  canRedoEditorHistory,
  canUndoEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
} from "@/core/editor/editor-history";
import {
  selectedSequence,
  selectionIsQuoted,
  selectionListKind,
} from "@/core/editor/extensions/nesting";
import { linkAttributesAtSelection } from "@/core/editor/links";

import {
  alignableBlocksInSelection,
  alignSelectedBlocks,
  type BlockAlignment,
  currentAlignableBlock,
} from "../../block-alignment";

export type ToolbarControlId =
  | "undo"
  | "redo"
  | "heading"
  | "bold"
  | "italic"
  | "codeBlock"
  | "bulletList"
  | "link"
  | "alignment"
  | "uploadFigure";

/** Why a control cannot apply here. The surface turns these into writer copy. */
export type ToolbarBlockedReason =
  | "editor-loading"
  | "document-read-only"
  | "object-selection"
  | "code-block"
  | "embedded-block"
  | "mixed-selection"
  | "inline-code"
  | "no-alignable-block"
  | "empty-history"
  | "code-document"
  | "no-project";

/** The subset a whole-block conversion can refuse with. */
export type BlockTypeRefusalReason = Extract<
  ToolbarBlockedReason,
  "object-selection" | "code-block" | "embedded-block" | "mixed-selection"
>;

export type ToolbarControlState = {
  /** Lit when the control's state is currently applied (, F9). */
  active: boolean;
  /** Null when the control can run; a reason to show otherwise (). */
  blockedBy: ToolbarBlockedReason | null;
};

export type ToolbarControlStates = Record<ToolbarControlId, ToolbarControlState>;

/** A control state whose refusal can only be a whole-block one. */
export type BlockTypeState = ToolbarControlState & { blockedBy: BlockTypeRefusalReason | null };

export type ToolbarMarkName = "strong" | "em" | "code" | "strike";

/** A heading level as a block type: `heading1` is a paragraph at level 1. */
export type HeadingBlockTypeId = `heading${HeadingLevel}`;

/** The block types "Turn into" offers. */
export type BlockTypeId =
  | "paragraph"
  | HeadingBlockTypeId
  | "bulletList"
  | "orderedList"
  | "quote"
  | "codeBlock";

/** Body text and every heading level the schema allows. */
const TEXT_LEVEL_BLOCK_TYPE_IDS: readonly BlockTypeId[] = [
  "paragraph",
  ...HEADING_LEVELS.map((level): HeadingBlockTypeId => `heading${level}`),
];

export const BLOCK_TYPE_IDS: readonly BlockTypeId[] = [
  ...TEXT_LEVEL_BLOCK_TYPE_IDS,
  "bulletList",
  "orderedList",
  "quote",
  "codeBlock",
];

const HEADING_BLOCK_TYPE_LEVELS: Partial<Record<BlockTypeId, HeadingLevel>> = Object.fromEntries(
  HEADING_LEVELS.map((level) => [`heading${level}`, level]),
);

export function headingLevelOf(id: HeadingBlockTypeId): HeadingLevel {
  return HEADING_BLOCK_TYPE_LEVELS[id] as HeadingLevel;
}

/** The level a block type sets: null for body text, undefined for a type that is no level. */
export function blockTypeLevel(id: BlockTypeId): HeadingLevel | null | undefined {
  return id === "paragraph" ? null : HEADING_BLOCK_TYPE_LEVELS[id];
}

/** Alignment as the dropdown speaks it: `null` on the wire reads as default. */
export type ToolbarAlignmentValue = "default" | Exclude<BlockAlignment, null>;

export type ToolbarContext = {
  editor: Editor | null;
  /** False behind a schema fence or a read-only host; every verb greys. */
  editable: boolean;
  /** A code file holds one code block; the document-only verbs cannot serve it. */
  schemaType: YjsTrackedSchemaType;
  canUndo: boolean;
  canRedo: boolean;
  /** Uploads land in a project's asset namespace; without one there is none. */
  imageUploadAvailable: boolean;
};

const CONTROL_IDS: readonly ToolbarControlId[] = [
  "undo",
  "redo",
  "heading",
  "bold",
  "italic",
  "codeBlock",
  "bulletList",
  "link",
  "alignment",
  "uploadFigure",
];

export function documentToolbarControls(context: ToolbarContext): ToolbarControlStates {
  const { editor } = context;
  if (!editor || editor.isDestroyed) return everyControlBlockedBy("editor-loading");

  // Read-only outranks every contextual reason: nothing applies to a document
  // the writer cannot change, and saying so once is the honest answer.
  const readOnly: ToolbarBlockedReason | null = context.editable ? null : "document-read-only";
  const blockType = blockTypeRefusal(editor);
  const alignment = currentAlignmentValue(editor);

  return {
    undo: {
      active: false,
      blockedBy: readOnly ?? (context.canUndo ? null : "empty-history"),
    },
    redo: {
      active: false,
      blockedBy: readOnly ?? (context.canRedo ? null : "empty-history"),
    },
    heading: {
      active: currentHeadingLevel(editor) !== null,
      blockedBy: readOnly ?? blockType,
    },
    bold: blockedFirst(readOnly, textMarkState(editor, "strong")),
    italic: blockedFirst(readOnly, textMarkState(editor, "em")),
    codeBlock: {
      active: editor.isActive("code_block"),
      blockedBy: readOnly ?? codeBlockRefusal(editor),
    },
    bulletList: {
      active: activeListKind(editor) === "bullet",
      blockedBy: readOnly ?? blockType,
    },
    // No precondition on having a selection: a bare caret opens the
    // two-field form instead.
    link: blockedFirst(readOnly, textMarkState(editor, "link")),
    alignment: {
      active: alignment !== "default",
      blockedBy:
        readOnly ??
        (alignableBlocksInSelection(editor.state).length > 0 ? null : "no-alignable-block"),
    },
    uploadFigure: {
      active: false,
      blockedBy: readOnly ?? uploadBlocker(context),
    },
  };
}

/** The alignment the dropdown should show for the blocks under the selection. */
export function currentAlignmentValue(editor: Editor): ToolbarAlignmentValue {
  const align = currentAlignableBlock(editor.state)?.node.attrs.align;
  return align === "center" || align === "right" ? align : "default";
}

/** What a mark control should show: lit when applied, and the reason it cannot apply otherwise. */
export function textMarkState(editor: Editor, mark: ToolbarMarkName | "link"): ToolbarControlState {
  return { active: isMarkActive(editor, mark), blockedBy: markBlocker(editor, mark) };
}

/** The whole "Turn into" truth table for the current selection (): which type the blocks already are, and why the others cannot apply here. */
export function blockTypeStates(editor: Editor): Record<BlockTypeId, BlockTypeState> {
  const strict = blockTypeRefusal(editor);
  const reversible = codeBlockRefusal(editor);
  const activeId = activeBlockTypeId(editor);

  return Object.fromEntries(
    BLOCK_TYPE_IDS.map((id) => [
      id,
      {
        active: id === activeId,
        blockedBy: id === "paragraph" || id === "codeBlock" ? reversible : strict,
      },
    ]),
  ) as Record<BlockTypeId, BlockTypeState>;
}

/**
 * The toolbar's heading menu: Turn into's body text and heading rows, current by level alone, so
 * an item or a quoted line still shows the level it has.
 */
export function textLevelStates(editor: Editor): { id: BlockTypeId; state: BlockTypeState }[] {
  const states = blockTypeStates(editor);
  // Undefined when the blocks share no level, so no row reads as current.
  const level = editor.isActive("paragraph", { level: null })
    ? null
    : (currentHeadingLevel(editor) ?? undefined);
  return TEXT_LEVEL_BLOCK_TYPE_IDS.map((id) => ({
    id,
    state: { active: blockTypeLevel(id) === level, blockedBy: states[id].blockedBy },
  }));
}

/** The block type the selection already is. */
function activeBlockTypeId(editor: Editor): BlockTypeId | null {
  if (editor.isActive("code_block")) return "codeBlock";
  const listKind = activeListKind(editor);
  if (listKind === "bullet") return "bulletList";
  if (listKind === "ordered") return "orderedList";
  if (selectionIsQuoted(selectedSequence(editor.state.selection))) return "quote";
  const level = currentHeadingLevel(editor);
  if (level !== null) return `heading${level}`;
  return editor.isActive("paragraph", { level: null }) ? "paragraph" : null;
}

/** The heading level every block under the selection has, or null when they share none. */
export function currentHeadingLevel(editor: Editor): HeadingLevel | null {
  return HEADING_LEVELS.find((level) => editor.isActive("paragraph", { level })) ?? null;
}

/** Convert the blocks under the selection in place. */
export function turnIntoBlockType(editor: Editor, id: BlockTypeId): boolean {
  if (!canWrite(editor) || blockTypeStates(editor)[id].blockedBy) return false;

  const { selection } = editor.state;
  if (selection instanceof CellSelection) return turnIntoSweptCells(editor, id, selection);
  return applyBlockType(editor, id);
}

/** The conversion behind Turn into for one selection, toggle semantics intact. */
function applyBlockType(editor: Editor, id: BlockTypeId): boolean {
  const level = blockTypeLevel(id);
  if (level) return editor.chain().focus().toggleHeadingLevel({ level }).run();

  switch (id) {
    // Body text from any text block, a fence included: a level change touches paragraphs only.
    case "paragraph":
      return editor.chain().focus().setParagraph().run();
    case "bulletList":
      return editor.chain().focus().toggleListKind("bullet").run();
    case "orderedList":
      return editor.chain().focus().toggleListKind("ordered").run();
    case "quote":
      return editor.chain().focus().toggleQuote().run();
    default:
      return editor.chain().focus().toggleCodeBlock().run();
  }
}

/** Per-block application across a swept rectangle — the shape marks already have. */
function turnIntoSweptCells(editor: Editor, id: BlockTypeId, selection: CellSelection): boolean {
  const undoes = activeBlockTypeId(editor) === id;
  const cells = selection.ranges.map((range) => ({ from: range.$from.pos, to: range.$to.pos }));
  let anchor = selection.$anchorCell.pos;
  let head = selection.$headCell.pos;

  // Every conversion moves the positions after it; the walk follows the
  // document through the transaction events.
  const followDocument = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    for (const cell of cells) {
      cell.from = transaction.mapping.map(cell.from, 1);
      cell.to = transaction.mapping.map(cell.to, -1);
    }
    anchor = transaction.mapping.map(anchor);
    head = transaction.mapping.map(head);
  };
  editor.on("transaction", followDocument);

  try {
    let applied = false;
    for (const cell of cells) {
      const selected = editor.commands.command(({ tr, dispatch }) => {
        if (dispatch) {
          tr.setSelection(
            TextSelection.between(tr.doc.resolve(cell.from), tr.doc.resolve(cell.to)),
          );
        }
        return true;
      });
      if (!selected) continue;
      // Already what the sweep converges on: applying the toggle would undo it.
      if (!undoes && activeBlockTypeId(editor) === id) continue;
      if (applyBlockType(editor, id)) applied = true;
    }

    editor.commands.command(({ tr, dispatch }) => {
      if (dispatch) {
        tr.setSelection(new CellSelection(tr.doc.resolve(anchor), tr.doc.resolve(head)));
      }
      return true;
    });
    return applied;
  } finally {
    editor.off("transaction", followDocument);
  }
}

/** Read-only outranks every contextual reason, and still reports the state. */
export function blockedFirst<Outranking, Reason>(
  outranking: Outranking | null,
  state: { active: boolean; blockedBy: Reason | null },
): { active: boolean; blockedBy: Outranking | Reason | null } {
  return outranking ? { active: state.active, blockedBy: outranking } : state;
}

/** True toggle: one press fences the block, one press returns it to prose. */
export function toggleCodeBlockBlock(editor: Editor): boolean {
  return turnIntoBlockType(editor, "codeBlock");
}

/** True toggle: one press lists, one press un-lists, however deep (). */
export function toggleBulletListBlock(editor: Editor): boolean {
  return turnIntoBlockType(editor, "bulletList");
}

export function toggleTextMark(editor: Editor, mark: ToolbarMarkName): boolean {
  if (!canWrite(editor) || markBlocker(editor, mark)) return false;
  const chain = editor.chain().focus();
  if (mark === "strong") return chain.toggleBold().run();
  if (mark === "em") return chain.toggleItalic().run();
  if (mark === "strike") return chain.toggleStrike().run();
  return chain.toggleCode().run();
}

export function setToolbarAlignment(editor: Editor, value: ToolbarAlignmentValue): boolean {
  if (!canWrite(editor)) return false;
  const align: BlockAlignment = value === "default" ? null : value;
  const transaction = alignSelectedBlocks(editor.state, align);
  if (!transaction) return false;
  editor.view.dispatch(transaction);
  editor.commands.focus();
  return true;
}

/** Toolbar and keymap traverse the same mounted editor history. */
export function undoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  editor.commands.focus();
  return undoEditorHistory(editor);
}

export function redoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  editor.commands.focus();
  return redoEditorHistory(editor);
}

export function canUndoDocument(editor: Editor | null): boolean {
  return Boolean(editor && hasCollaborativeHistory(editor) && canUndoEditorHistory(editor));
}

export function canRedoDocument(editor: Editor | null): boolean {
  return Boolean(editor && hasCollaborativeHistory(editor) && canRedoEditorHistory(editor));
}

function canWrite(editor: Editor): boolean {
  // TipTap chains run on a non-editable editor, so every command re-reads
  // editability instead of trusting that the surface withheld the press.
  return !editor.isDestroyed && editor.isEditable;
}

function hasCollaborativeHistory(editor: Editor): boolean {
  return !editor.isDestroyed && typeof editor.commands.undo === "function";
}

/** The kind of list every selected block sits in, or null when they are not all in one kind. */
function activeListKind(editor: Editor): "bullet" | "ordered" | null {
  return selectionListKind(selectedSequence(editor.state.selection));
}

function uploadBlocker(context: ToolbarContext): ToolbarBlockedReason | null {
  if (context.schemaType !== "document") return "code-document";
  // Nothing about an upload already running blocks the next one: each picture
  // holds its own slot in the document and its own progress with it.
  return context.imageUploadAvailable ? null : "no-project";
}

/** What the deepest context under the selection refuses, or null when that context is the document itself and nothing local stands in the way. */
function chromeContextRefusal(context: ChromeContext): BlockTypeRefusalReason | null {
  switch (context.owner) {
    case "object":
      return context.nodeType === "code_block" ? "embedded-block" : "object-selection";
    case "source-block":
      return context.nodeType === "code_block" ? "code-block" : "embedded-block";
    // A cell holds any block, so the cell itself refuses nothing: anything in
    // it that does (a rendered fence, a component) owns the context more
    // deeply and answered above. The table arm is the same story one level up.
    case "table":
    case "table-cell":
    case "document":
      return null;
  }
}

/** The block-type fence, shared with every other surface that rewrites a whole block (the block menu's Turn into, the formatting menu's). */
export function blockTypeRefusal(editor: Editor): BlockTypeRefusalReason | null {
  const owner = chromeContextRefusal(resolveChromeContext(editor.state));
  if (owner) return owner;

  const refusals = spannedRefusals(editor.state);
  if (refusals.length === 0) return "object-selection";

  const refused = refusals.filter((reason) => reason !== null);
  if (refused.length === 0) return null;

  // ANY protected target refuses the whole conversion: a selection spanning a
  // mermaid fence and a paragraph is the ordinary Ctrl+A, and converting it
  // would drop the fence's language along with the fence. The reason may name
  // one kind only when every block in the span refuses as that kind.
  const uniform =
    refused.length === refusals.length && refused.every((reason) => reason === refused[0]);
  return uniform ? refused[0] : "mixed-selection";
}

/** The fence for the two commands a plain code block REVERSES rather than refuses — the code-block toggle and "turn into paragraph". */
export function codeBlockRefusal(editor: Editor): BlockTypeRefusalReason | null {
  const blocker = blockTypeRefusal(editor);
  return blocker === "code-block" ? null : blocker;
}

function markBlocker(editor: Editor, mark: ToolbarMarkName | "link"): ToolbarBlockedReason | null {
  const noProse = noProseToMark(editor);
  if (noProse) return noProse;

  // A mark that is already there can always come off (), whatever the
  // schema thinks about adding it.
  if (isMarkActive(editor, mark)) return null;
  // `can().setMark` is the command's own answer — schema allowance and mark
  // exclusions both. The only exclusion in this schema is the inline code
  // mark, which excludes every other mark from the text it covers.
  return editor.can().setMark(mark) ? null : "inline-code";
}

/** Why the selection holds no prose a mark could land on, or null when it holds some: marks land per node, so a mixed selection formats the prose it reaches and leaves the rest alone. */
function noProseToMark(editor: Editor): BlockTypeRefusalReason | null {
  const { state } = editor;
  const refusals = spannedRefusals(state);
  // Nothing in the span holds text at all: a figure, a rule, an empty document.
  if (refusals.length === 0) {
    return chromeContextRefusal(resolveChromeContext(state)) ?? "object-selection";
  }
  if (refusals.some((reason) => reason === null)) return null;
  return refusals[0] ?? null;
}

/** What each text block the selection covers refuses, in document order. */
function spannedRefusals(state: EditorState): (BlockTypeRefusalReason | null)[] {
  const { doc, selection } = state;
  const refusals: (BlockTypeRefusalReason | null)[] = [];
  for (const range of selection.ranges) {
    doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (node.isTextblock) refusals.push(chromeContextRefusal(chromeContextAt(doc, pos + 1)));
    });
  }
  return refusals;
}

function isMarkActive(editor: Editor, mark: ToolbarMarkName | "link"): boolean {
  return mark === "link" ? linkAttributesAtSelection(editor) !== null : editor.isActive(mark);
}

function everyControlBlockedBy(reason: ToolbarBlockedReason): ToolbarControlStates {
  return Object.fromEntries(
    CONTROL_IDS.map((id) => [id, { active: false, blockedBy: reason }]),
  ) as ToolbarControlStates;
}
