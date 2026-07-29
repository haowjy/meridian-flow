/**
 * The document toolbar's command layer: what each control can do in the
 * current context, and the fenced commands behind the controls.
 *
 * Two jobs live here because they share one set of refusal predicates, and the
 * sharing is the point — a control may never advertise what dispatch will
 * refuse:
 *
 * - `documentToolbarControls` derives the enablement matrix the toolbar
 *   renders. A control that cannot apply reports WHY, so the surface can grey
 *   it with a reason instead of letting a press silently no-op (law 5). The
 *   matrix never removes a control: the toolbar's geometry is fixed
 *   (ruling 15).
 * - the exported commands re-check the same predicates before touching the
 *   document. The greyed button is the first fence; this is the second, and
 *   for the block-type commands it is load-bearing — a selected figure, a
 *   mermaid fence, or a registered component must never convert into a
 *   heading, however the command is reached (interaction model §7, F6).
 *
 * The two families fence differently on purpose. A block-type conversion
 * rewrites whole blocks, so it refuses a selection where ANY target is
 * protected. A mark lands only on the inline content that accepts it, so it
 * refuses only when NO target can take it.
 */

import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import type { Level } from "@tiptap/extension-heading";
import { type EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";

import { type ChromeContext, chromeContextAt, resolveChromeContext } from "@/core/editor/chrome";
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
  | "table-cell"
  | "inline-code"
  | "no-alignable-block"
  | "empty-history"
  | "code-document"
  | "no-project"
  | "upload-in-flight";

/**
 * The subset a whole-block conversion can refuse with. Named because the block
 * menu's Turn into and the formatting menu's carry the same verbs and must
 * refuse the same targets — `blockTypeRefusal` is the one fence behind all of
 * them, and its answers are these.
 */
export type BlockTypeRefusalReason = Extract<
  ToolbarBlockedReason,
  "object-selection" | "code-block" | "embedded-block" | "mixed-selection" | "table-cell"
>;

export type ToolbarControlState = {
  /** Lit when the control's state is currently applied (law 6, F9). */
  active: boolean;
  /** Null when the control can run; a reason to show otherwise (law 5). */
  blockedBy: ToolbarBlockedReason | null;
};

export type ToolbarControlStates = Record<ToolbarControlId, ToolbarControlState>;

export type ToolbarMarkName = "strong" | "em" | "code" | "strike";

/**
 * The block types "Turn into" offers (§5.1). The toolbar carries three of them
 * as buttons; the formatting menu and the block menu carry the whole list, and
 * every one of them refuses through the fence below — which is why the set
 * lives here rather than beside the menu that renders it.
 */
export type BlockTypeId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "blockquote"
  | "codeBlock";

export const BLOCK_TYPE_IDS: readonly BlockTypeId[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
];

/** The three heading levels "Turn into" offers; the schema allows six. */
const BLOCK_TYPE_HEADING_LEVELS = {
  heading1: 1,
  heading2: 2,
  heading3: 3,
} as const satisfies Partial<Record<BlockTypeId, Level>>;

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
  imageUploadBusy: boolean;
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

const TOOLBAR_HEADING_LEVEL = 1;

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
      active: editor.isActive("heading", { level: TOOLBAR_HEADING_LEVEL }),
      blockedBy: readOnly ?? blockType,
    },
    bold: blockedFirst(readOnly, textMarkState(editor, "strong")),
    italic: blockedFirst(readOnly, textMarkState(editor, "em")),
    codeBlock: {
      active: editor.isActive("code_block"),
      blockedBy: readOnly ?? codeBlockRefusal(editor),
    },
    bulletList: {
      active: editor.isActive("bullet_list"),
      blockedBy: readOnly ?? blockType,
    },
    // No precondition on having a selection: a bare caret opens the
    // two-field form instead (interaction model §5.5).
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

/**
 * What a mark control should show: lit when applied, and the reason it cannot
 * apply otherwise. The toolbar's own bold/italic/link rows read this, and so
 * does every surface that carries the same marks, so a control can never
 * advertise what `toggleTextMark` will refuse.
 */
export function textMarkState(editor: Editor, mark: ToolbarMarkName | "link"): ToolbarControlState {
  return { active: isMarkActive(editor, mark), blockedBy: markBlocker(editor, mark) };
}

/**
 * The whole "Turn into" truth table for the current selection (law 6): which
 * type the blocks already are, and why the others cannot apply here.
 *
 * `paragraph` and `codeBlock` share the code-block exception the toolbar's
 * Code button has — a plain fence is what they REVERSE, so a fence is not a
 * refusal for either of them. Every other type refuses it, and an object fence
 * (a rendered mermaid diagram) refuses all eight: un-fencing a diagram would
 * destroy it exactly the way converting one to a heading would (F6).
 */
export function blockTypeStates(editor: Editor): Record<BlockTypeId, ToolbarControlState> {
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
  ) as Record<BlockTypeId, ToolbarControlState>;
}

/**
 * The block type the selection already is. Exactly one, deepest wins: a
 * paragraph inside a bullet list is a bullet list, or the menu would show two
 * checks for one block.
 */
function activeBlockTypeId(editor: Editor): BlockTypeId | null {
  if (editor.isActive("code_block")) return "codeBlock";
  if (editor.isActive("bullet_list")) return "bulletList";
  if (editor.isActive("ordered_list")) return "orderedList";
  if (editor.isActive("blockquote")) return "blockquote";
  for (const [id, level] of Object.entries(BLOCK_TYPE_HEADING_LEVELS)) {
    if (editor.isActive("heading", { level })) return id as BlockTypeId;
  }
  return editor.isActive("paragraph") ? "paragraph" : null;
}

function headingLevel(id: BlockTypeId): Level | null {
  return id in BLOCK_TYPE_HEADING_LEVELS
    ? BLOCK_TYPE_HEADING_LEVELS[id as keyof typeof BLOCK_TYPE_HEADING_LEVELS]
    : null;
}

/**
 * Convert the blocks under the selection in place (§5.1). A true toggle: the
 * type the blocks already are returns them to a paragraph, which is why the
 * menu can check the current type and reverse on a second choice.
 */
export function turnIntoBlockType(editor: Editor, id: BlockTypeId): boolean {
  if (!canWrite(editor) || blockTypeStates(editor)[id].blockedBy) return false;

  const level = headingLevel(id);
  if (level) return editor.chain().focus().toggleHeading({ level }).run();

  switch (id) {
    case "paragraph":
      return editor.chain().focus().setParagraph().run();
    case "bulletList":
      return toggleListBlock(editor, "bullet_list");
    case "orderedList":
      return toggleListBlock(editor, "ordered_list");
    case "blockquote":
      return editor.chain().focus().toggleBlockquote().run();
    default:
      return editor.chain().focus().toggleCodeBlock().run();
  }
}

/** Read-only outranks every contextual reason, and still reports the state. */
function blockedFirst(
  readOnly: ToolbarBlockedReason | null,
  state: ToolbarControlState,
): ToolbarControlState {
  return readOnly ? { active: state.active, blockedBy: readOnly } : state;
}

/** True toggle: pressing on an H1 returns the block to a paragraph (law 6). */
export function toggleHeadingBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeRefusal(editor)) return false;
  return editor.chain().focus().toggleHeading({ level: TOOLBAR_HEADING_LEVEL }).run();
}

/** True toggle: one press fences the block, one press returns it to prose. */
export function toggleCodeBlockBlock(editor: Editor): boolean {
  if (!canWrite(editor) || codeBlockRefusal(editor)) return false;
  return editor.chain().focus().toggleCodeBlock().run();
}

/** True toggle: one press lists, one press un-lists, however deep (law 6). */
export function toggleBulletListBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeRefusal(editor)) return false;
  return toggleListBlock(editor, "bullet_list");
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

/**
 * Undo is the Yjs UndoManager's, shared with the Mod-z binding the editor owns
 * (ruling 17). It is the writer's recovery over LLM writes, so the toolbar
 * reports its real depth rather than a hopeful always-enabled button, and it
 * hands focus back to the prose like every other command here — a writer who
 * clicked Undo has not left editing, and the next Space must be a space.
 */
export function undoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  return editor.chain().focus().undo().run();
}

export function redoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  return editor.chain().focus().redo().run();
}

export function canUndoDocument(editor: Editor | null): boolean {
  return Boolean(editor && hasCollaborativeHistory(editor) && editor.can().undo());
}

export function canRedoDocument(editor: Editor | null): boolean {
  return Boolean(editor && hasCollaborativeHistory(editor) && editor.can().redo());
}

function canWrite(editor: Editor): boolean {
  // TipTap chains run on a non-editable editor, so every command re-reads
  // editability instead of trusting that the surface withheld the press.
  return !editor.isDestroyed && editor.isEditable;
}

function hasCollaborativeHistory(editor: Editor): boolean {
  return !editor.isDestroyed && typeof editor.commands.undo === "function";
}

/**
 * TipTap reverses a list by looking for an ancestor whose extension group holds
 * "list", and the Meridian list nodes declare `group: "block"` to stay in
 * parity with the server schema — so its own toggle only ever wraps. Owning the
 * reverse means owning all of it.
 *
 * And "all of it" is one list at a time. `liftListItem` works on the block
 * range around the selection, and a selection spanning two sibling lists has no
 * single range to lift: it refuses, and a checked control that does nothing is
 * exactly what law 6 forbids. So each list the writer's range reaches is lifted
 * on its own, and that range travels through the lifts — every lift moves the
 * positions after it.
 */
function toggleListBlock(editor: Editor, listType: "bullet_list" | "ordered_list"): boolean {
  if (!editor.isActive(listType)) {
    const chain = editor.chain().focus();
    return listType === "bullet_list"
      ? chain.toggleBulletList().run()
      : chain.toggleOrderedList().run();
  }

  let range = { from: editor.state.selection.from, to: editor.state.selection.to };
  const followDocument = ({ transaction }: { transaction: Transaction }) => {
    if (!transaction.docChanged) return;
    range = {
      from: transaction.mapping.map(range.from, 1),
      to: transaction.mapping.map(range.to, -1),
    };
  };
  editor.on("transaction", followDocument);

  try {
    let lifted = false;
    // Each lift removes at least the two tokens of the list it unwrapped, so
    // the document's own size is a bound that always terminates.
    for (let guard = editor.state.doc.content.size; guard > 0; guard -= 1) {
      const target = listRangeReachedBy(editor.state, listType, range);
      if (!target) break;
      const chain = editor.chain().focus().setTextSelection(target);
      if (!chain.liftListItem("list_item").run()) break;
      lifted = true;
    }
    // The writer selected words, not list items; give them back what they had.
    if (lifted) editor.commands.setTextSelection(range);
    return lifted;
  } finally {
    editor.off("transaction", followDocument);
  }
}

/**
 * The part of the next list of this type that the writer's range actually
 * reaches, or null when none is left.
 *
 * Only the overlap is lifted, so a caret in one item still un-lists that item
 * alone. "Reaches" is strict for a caret: once its item has been lifted out,
 * the caret sits against the remaining list's edge rather than inside it, and
 * counting that would un-list a list the writer never pointed at.
 */
function listRangeReachedBy(
  state: EditorState,
  listType: string,
  range: { from: number; to: number },
): { from: number; to: number } | null {
  const { doc } = state;
  const from = Math.max(0, Math.min(range.from, doc.content.size));
  const to = Math.max(from, Math.min(range.to, doc.content.size));

  let found: { from: number; to: number } | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.type.name !== listType) return true;

    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    if (from === to && (from <= contentFrom || from >= contentTo)) return true;

    const overlapFrom = Math.max(from, contentFrom);
    const overlapTo = Math.min(to, contentTo);
    if (overlapFrom > overlapTo) return true;

    // A list's own boundary positions hold list items, not inline content, so
    // a text selection cannot sit on them; `between` walks in to the nearest
    // positions that can hold a caret.
    const snapped = TextSelection.between(doc.resolve(overlapFrom), doc.resolve(overlapTo));
    found = { from: snapped.from, to: snapped.to };
    return false;
  });
  return found;
}

function uploadBlocker(context: ToolbarContext): ToolbarBlockedReason | null {
  if (context.schemaType !== "document") return "code-document";
  if (!context.imageUploadAvailable) return "no-project";
  return context.imageUploadBusy ? "upload-in-flight" : null;
}

/**
 * What the deepest context under the selection refuses, or null when that
 * context is the document itself and nothing local stands in the way.
 *
 * The kernel already resolves that context for the Esc chain and the
 * context-menu router (`core/editor/chrome`); this reads the same answer as a
 * reason. Inspecting the selection a second time here is precisely what used
 * to grey a whole SELECTED table as though the caret were in a cell:
 * prosemirror-tables spells "this table is selected" as a `CellSelection`, and
 * only the kernel's resolver reads both spellings.
 *
 * The resolver is called rather than the kernel's cached `chrome.context`,
 * because the commands re-check this fence mid-chain and a code-schema
 * document mounts no chrome at all.
 *
 * A `code_block` reads two ways, and the owner is what decides which: one that
 * owns an `object` context is a RENDERED fence — a diagram on the page, since
 * the kernel only names an object what `isEditorObject` accepts — while one
 * that owns a `source-block` context is a plain fence the writer types in.
 */
function chromeContextRefusal(context: ChromeContext): BlockTypeRefusalReason | null {
  switch (context.owner) {
    case "object":
      return context.nodeType === "code_block" ? "embedded-block" : "object-selection";
    case "source-block":
      return context.nodeType === "code_block" ? "code-block" : "embedded-block";
    // A table never owns the context without a cell owning it more deeply, and
    // the answer would be the same either way: neither is a conversion target.
    case "table":
    case "table-cell":
      return "table-cell";
    case "document":
      return null;
  }
}

/**
 * The block-type fence, shared with every other surface that rewrites a whole
 * block (the block menu's Turn into, the formatting menu's). Exported so those
 * surfaces refuse the same targets for the same reasons rather than growing a
 * second fence beside this one.
 *
 * Two readings, in order. The deepest context under the selection answers
 * first, because a writer standing inside something is owed that thing's
 * reason: a caret in a diagram nested in a table cell is in the DIAGRAM. Only
 * when the document itself owns the context does what the selection SPANS
 * decide, and then every block it covers is read through the same resolver at
 * its own position.
 */
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

/**
 * The fence for the two commands a plain code block REVERSES rather than
 * refuses — the code-block toggle and "turn into paragraph". Pressing either
 * inside a fence returns the block to prose (law 6), so only the reasons that
 * would destroy something still stand: an object, a component, a table cell,
 * or a mixed selection where the conversion would strip a fence's language
 * along the way.
 *
 * A rendered object fence is NOT reversible here. Its reason is
 * `embedded-block` rather than `code-block`, so un-fencing a mermaid diagram
 * refuses like every other conversion (F6, and the reason the menu can offer
 * "Paragraph" at all).
 */
export function codeBlockRefusal(editor: Editor): BlockTypeRefusalReason | null {
  const blocker = blockTypeRefusal(editor);
  return blocker === "code-block" ? null : blocker;
}

function markBlocker(editor: Editor, mark: ToolbarMarkName | "link"): ToolbarBlockedReason | null {
  const noProse = noProseToMark(editor);
  if (noProse) return noProse;

  // A mark that is already there can always come off (law 6), whatever the
  // schema thinks about adding it.
  if (isMarkActive(editor, mark)) return null;
  // `can().setMark` is the command's own answer — schema allowance and mark
  // exclusions both. The only exclusion in this schema is the inline code
  // mark, which excludes every other mark from the text it covers.
  return editor.can().setMark(mark) ? null : "inline-code";
}

/**
 * Why the selection holds no prose a mark could land on, or null when it holds
 * some: marks land per node, so a mixed selection formats the prose it reaches
 * and leaves the rest alone.
 *
 * A table cell IS prose (§5.4), which is the one place marks part ways with
 * the block-type fence — a cell refuses to become a heading and takes bold in
 * the same breath. It matters most for a selected table, whose cells hold
 * every word in it.
 */
function noProseToMark(editor: Editor): BlockTypeRefusalReason | null {
  const { state } = editor;
  const refusals = spannedRefusals(state);
  // Nothing in the span holds text at all: a figure, a rule, an empty document.
  if (refusals.length === 0) {
    return chromeContextRefusal(resolveChromeContext(state)) ?? "object-selection";
  }
  if (refusals.some((reason) => reason === null || reason === "table-cell")) return null;
  return refusals[0] ?? null;
}

/**
 * What each text block the selection covers refuses, in document order.
 *
 * Walks `selection.ranges` rather than `from`..`to`: a `CellSelection` reports
 * only its FIRST cell as that pair, while ProseMirror's own commands run over
 * every range — so a fence sitting in the fourth cell would be advertised as
 * convertible and then refused by dispatch, which is the dead control law 5
 * forbids.
 *
 * Each block is read at its own first inside position, so the resolver answers
 * about the block rather than about its neighbours. A selection is not a
 * context; asking per block is what tells a select-all across a fence from a
 * caret inside one.
 */
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
