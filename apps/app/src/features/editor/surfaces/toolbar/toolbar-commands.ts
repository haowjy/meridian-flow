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
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import { AllSelection, NodeSelection } from "@tiptap/pm/state";

import {
  alignableBlocksInSelection,
  alignSelectedBlocks,
  type BlockAlignment,
  currentAlignableBlock,
} from "../../block-alignment";
import { linkAttributesAtSelection } from "../../link-selection";

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

export type ToolbarControlState = {
  /** Lit when the control's state is currently applied (law 6, F9). */
  active: boolean;
  /** Null when the control can run; a reason to show otherwise (law 5). */
  blockedBy: ToolbarBlockedReason | null;
};

export type ToolbarControlStates = Record<ToolbarControlId, ToolbarControlState>;

export type ToolbarMarkName = "strong" | "em" | "code";

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

/** A list item lifts one level per press; no manuscript nests this deep. */
const MAX_LIST_UNWRAP_STEPS = 20;

export function documentToolbarControls(context: ToolbarContext): ToolbarControlStates {
  const { editor } = context;
  if (!editor || editor.isDestroyed) return everyControlBlockedBy("editor-loading");

  // Read-only outranks every contextual reason: nothing applies to a document
  // the writer cannot change, and saying so once is the honest answer.
  const readOnly: ToolbarBlockedReason | null = context.editable ? null : "document-read-only";
  const blockType = blockTypeBlocker(editor);
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
    bold: {
      active: editor.isActive("strong"),
      blockedBy: readOnly ?? markBlocker(editor, "strong"),
    },
    italic: {
      active: editor.isActive("em"),
      blockedBy: readOnly ?? markBlocker(editor, "em"),
    },
    codeBlock: {
      active: editor.isActive("code_block"),
      blockedBy: readOnly ?? codeBlockBlocker(editor),
    },
    bulletList: {
      active: editor.isActive("bullet_list"),
      blockedBy: readOnly ?? blockType,
    },
    link: {
      // No precondition on having a selection: a bare caret opens the
      // two-field form instead (interaction model §5.5).
      active: linkAttributesAtSelection(editor) !== null,
      blockedBy: readOnly ?? markBlocker(editor, "link"),
    },
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

/** True toggle: pressing on an H1 returns the block to a paragraph (law 6). */
export function toggleHeadingBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeBlocker(editor)) return false;
  return editor.chain().focus().toggleHeading({ level: TOOLBAR_HEADING_LEVEL }).run();
}

/** True toggle: one press fences the block, one press returns it to prose. */
export function toggleCodeBlockBlock(editor: Editor): boolean {
  if (!canWrite(editor) || codeBlockBlocker(editor)) return false;
  return editor.chain().focus().toggleCodeBlock().run();
}

/** True toggle: one press lists, one press un-lists, however deep (law 6). */
export function toggleBulletListBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeBlocker(editor)) return false;
  if (!editor.isActive("bullet_list")) return editor.chain().focus().toggleBulletList().run();
  return unwrapBulletList(editor);
}

export function toggleTextMark(editor: Editor, mark: ToolbarMarkName): boolean {
  if (!canWrite(editor) || markBlocker(editor, mark)) return false;
  const chain = editor.chain().focus();
  if (mark === "strong") return chain.toggleBold().run();
  if (mark === "em") return chain.toggleItalic().run();
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
 * reverse means owning all of it: a nested item lifts one level per call, and
 * `AllSelection` (Ctrl+A) carries no block range for `liftListItem` to work
 * with until it is spelled as a text selection.
 */
function unwrapBulletList(editor: Editor): boolean {
  if (editor.state.selection instanceof AllSelection) {
    const { doc } = editor.state;
    editor.commands.setTextSelection({ from: 0, to: doc.content.size });
  }

  let lifted = false;
  for (let step = 0; step < MAX_LIST_UNWRAP_STEPS && editor.isActive("bullet_list"); step += 1) {
    if (!editor.chain().focus().liftListItem("list_item").run()) break;
    lifted = true;
  }
  return lifted;
}

function uploadBlocker(context: ToolbarContext): ToolbarBlockedReason | null {
  if (context.schemaType !== "document") return "code-document";
  if (!context.imageUploadAvailable) return "no-project";
  return context.imageUploadBusy ? "upload-in-flight" : null;
}

/**
 * The refusal that makes the F6 accident unreachable: a node selection on
 * anything that is not a text block (figure, image, horizontal rule, table) is
 * not a block-type target, and formatting has no text to land on either.
 */
function objectSelectionBlocker(editor: Editor): ToolbarBlockedReason | null {
  const { selection } = editor.state;
  return selection instanceof NodeSelection && !selection.node.isTextblock
    ? "object-selection"
    : null;
}

function blockTypeBlocker(editor: Editor): ToolbarBlockedReason | null {
  const objectSelection = objectSelectionBlocker(editor);
  if (objectSelection) return objectSelection;

  const targets = textblockTargets(editor);
  if (targets.length === 0) return "object-selection";

  // ANY protected target refuses the whole conversion: a selection spanning a
  // mermaid fence and a paragraph is the ordinary Ctrl+A, and converting it
  // would drop the fence's language along with the fence.
  const protectedTargets = targets.filter(
    (target) => isNonProseTextblock(target.node) || isInsideTableCell(target.$pos),
  );
  if (protectedTargets.length === 0) return null;
  if (protectedTargets.length < targets.length) return "mixed-selection";

  // Every target refuses, so the reason can name the kind that refused. A cell
  // holds exactly one paragraph, which covers a caret in a cell and a whole
  // CellSelection alike.
  const first = protectedTargets[0];
  return isInsideTableCell(first.$pos) ? "table-cell" : nonProseReason(first.node);
}

/**
 * The code-block control fences like its block-type siblings with one
 * exception: a code block is its REVERSAL target, not a refusal. Pressing
 * inside one returns the block to a paragraph (law 6), so only the reasons
 * that would destroy something still stand — an object, a component, a table
 * cell, or a mixed selection where a conversion would strip a fence's language
 * along the way.
 */
function codeBlockBlocker(editor: Editor): ToolbarBlockedReason | null {
  const blocker = blockTypeBlocker(editor);
  return blocker === "code-block" ? null : blocker;
}

function markBlocker(editor: Editor, mark: ToolbarMarkName | "link"): ToolbarBlockedReason | null {
  const objectSelection = objectSelectionBlocker(editor);
  if (objectSelection) return objectSelection;

  const targets = textblockTargets(editor);
  // Marks land per node, so only a selection with no prose in it at all is
  // refused; a mixed selection formats the prose and leaves the rest alone.
  if (targets.length > 0 && targets.every((target) => isNonProseTextblock(target.node))) {
    return nonProseReason(targets[0].node);
  }

  // A mark that is already there can always come off (law 6), whatever the
  // schema thinks about adding it.
  if (isMarkActive(editor, mark)) return null;
  // `can().setMark` is the command's own answer — schema allowance and mark
  // exclusions both. The only exclusion in this schema is the inline code
  // mark, which excludes every other mark from the text it covers.
  return editor.can().setMark(mark) ? null : "inline-code";
}

function isMarkActive(editor: Editor, mark: ToolbarMarkName | "link"): boolean {
  return mark === "link" ? linkAttributesAtSelection(editor) !== null : editor.isActive(mark);
}

type TextblockTarget = { node: PMNode; $pos: ResolvedPos };

function textblockTargets(editor: Editor): TextblockTarget[] {
  const { doc, selection } = editor.state;
  const targets: TextblockTarget[] = [];
  doc.nodesBetween(selection.from, selection.to, (node, pos) => {
    if (node.isTextblock) targets.push({ node, $pos: doc.resolve(pos) });
  });
  return targets;
}

/**
 * Blocks that hold text but are not prose. ProseMirror calls them text blocks;
 * a writer calls them a code fence and an embedded component, and a block-type
 * conversion silently drops what makes them one — the fence's language, the
 * component's name and props. Classified by the schema's own `code` flag
 * rather than by `isTextblock`, which is what let `jsx_leaf` through.
 */
function isNonProseTextblock(node: PMNode): boolean {
  return node.type.spec.code === true;
}

function nonProseReason(node: PMNode): ToolbarBlockedReason {
  return node.type.name === "code_block" ? "code-block" : "embedded-block";
}

function isInsideTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

function everyControlBlockedBy(reason: ToolbarBlockedReason): ToolbarControlStates {
  return Object.fromEntries(
    CONTROL_IDS.map((id) => [id, { active: false, blockedBy: reason }]),
  ) as ToolbarControlStates;
}
