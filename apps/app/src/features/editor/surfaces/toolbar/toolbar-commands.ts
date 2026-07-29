/**
 * The document toolbar's command layer: what each control can do in the
 * current context, and the fenced commands behind the controls.
 *
 * Two jobs live here because they share one set of refusal predicates:
 *
 * - `documentToolbarControls` derives the enablement matrix the toolbar
 *   renders. A control that cannot apply reports WHY, so the surface can grey
 *   it with a reason instead of letting a press silently no-op (law 5). The
 *   matrix never removes a control: the toolbar's geometry is fixed
 *   (ruling 15).
 * - the exported commands re-check those predicates before touching the
 *   document. The greyed button is the first fence; this is the second, and
 *   for the block-type commands it is load-bearing — a selected figure or
 *   diagram must never convert into a heading, however the command is reached
 *   (interaction model §7, F6).
 */
import type { Editor } from "@tiptap/core";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection } from "@tiptap/pm/state";

import {
  type BlockAlignment,
  currentAlignableBlock,
  setCurrentBlockAlignment,
} from "../../block-alignment";
import { linkAttributesAtSelection } from "../../link-selection";

export type ToolbarControlId =
  | "undo"
  | "redo"
  | "heading"
  | "bold"
  | "italic"
  | "code"
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
  | "no-alignable-block"
  | "empty-history"
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
  "code",
  "bulletList",
  "link",
  "alignment",
  "uploadFigure",
];

const TOOLBAR_HEADING_LEVEL = 1;

export function documentToolbarControls(context: ToolbarContext): ToolbarControlStates {
  const { editor } = context;
  if (!editor || editor.isDestroyed) return everyControlBlockedBy("editor-loading");

  const { state } = editor;
  // Read-only outranks every contextual reason: nothing applies to a document
  // the writer cannot change, and saying so once is the honest answer.
  const readOnly: ToolbarBlockedReason | null = context.editable ? null : "document-read-only";
  const blockType = blockTypeBlocker(state);
  const alignment = currentAlignmentValue(state);

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
      blockedBy: readOnly ?? markBlocker(state, "strong"),
    },
    italic: {
      active: editor.isActive("em"),
      blockedBy: readOnly ?? markBlocker(state, "em"),
    },
    code: {
      active: editor.isActive("code"),
      blockedBy: readOnly ?? markBlocker(state, "code"),
    },
    bulletList: {
      active: editor.isActive("bullet_list"),
      blockedBy: readOnly ?? blockType,
    },
    link: {
      // No precondition on having a selection: a bare caret opens the
      // two-field form instead (interaction model §5.5).
      active: linkAttributesAtSelection(editor) !== null,
      blockedBy: readOnly ?? objectSelectionBlocker(state),
    },
    alignment: {
      active: alignment !== "default",
      blockedBy: readOnly ?? (currentAlignableBlock(state) ? null : "no-alignable-block"),
    },
    uploadFigure: {
      active: false,
      blockedBy:
        readOnly ??
        (context.imageUploadAvailable
          ? context.imageUploadBusy
            ? "upload-in-flight"
            : null
          : "no-project"),
    },
  };
}

/** The alignment the dropdown should show for the block under the selection. */
export function currentAlignmentValue(state: EditorState): ToolbarAlignmentValue {
  const align = currentAlignableBlock(state)?.node.attrs.align;
  return align === "center" || align === "right" ? align : "default";
}

/** True toggle: pressing on an H1 returns the block to a paragraph (law 6). */
export function toggleHeadingBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeBlocker(editor.state)) return false;
  return editor.chain().focus().toggleHeading({ level: TOOLBAR_HEADING_LEVEL }).run();
}

/** True toggle: pressing inside a list un-lists it (law 6). */
export function toggleBulletListBlock(editor: Editor): boolean {
  if (!canWrite(editor) || blockTypeBlocker(editor.state)) return false;
  // TipTap reverses a list by finding an ancestor whose extension group holds
  // "list", and the Meridian list nodes declare `group: "block"` to stay in
  // parity with the server schema — so its own toggle only ever wraps. The
  // reverse half is spelled out here rather than by editing a schema the
  // server shares.
  if (editor.isActive("bullet_list")) {
    return editor.chain().focus().liftListItem("list_item").run();
  }
  return editor.chain().focus().toggleBulletList().run();
}

export function toggleTextMark(editor: Editor, mark: ToolbarMarkName): boolean {
  if (!canWrite(editor) || markBlocker(editor.state, mark)) return false;
  const chain = editor.chain().focus();
  if (mark === "strong") return chain.toggleBold().run();
  if (mark === "em") return chain.toggleItalic().run();
  return chain.toggleCode().run();
}

export function setToolbarAlignment(editor: Editor, value: ToolbarAlignmentValue): boolean {
  if (!canWrite(editor)) return false;
  const align: BlockAlignment = value === "default" ? null : value;
  const transaction = setCurrentBlockAlignment(editor.state, align);
  if (!transaction) return false;
  editor.view.dispatch(transaction);
  editor.commands.focus();
  return true;
}

/**
 * Undo is the Yjs UndoManager's, shared with the Mod-z binding the editor owns
 * (ruling 17). It is the writer's recovery over LLM writes, so the toolbar
 * reports its real depth rather than a hopeful always-enabled button.
 */
export function undoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  return editor.commands.undo();
}

export function redoDocument(editor: Editor): boolean {
  if (!canWrite(editor) || !hasCollaborativeHistory(editor)) return false;
  return editor.commands.redo();
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
 * The refusal that makes the F6 accident unreachable: a node selection on
 * anything that is not a text block (figure, image, horizontal rule, table) is
 * not a block-type target, and formatting has no text to land on either.
 */
function objectSelectionBlocker(state: EditorState): ToolbarBlockedReason | null {
  const { selection } = state;
  return selection instanceof NodeSelection && !selection.node.isTextblock
    ? "object-selection"
    : null;
}

function blockTypeBlocker(state: EditorState): ToolbarBlockedReason | null {
  const objectSelection = objectSelectionBlocker(state);
  if (objectSelection) return objectSelection;

  const targets = textblocksInSelection(state);
  if (targets.length === 0) return "object-selection";
  // A code block is a text block, so the object fence above lets it through:
  // converting one to a heading would silently strip its language and fence.
  return targets.every((node) => node.type.name === "code_block") ? "code-block" : null;
}

function markBlocker(state: EditorState, mark: ToolbarMarkName): ToolbarBlockedReason | null {
  const objectSelection = objectSelectionBlocker(state);
  if (objectSelection) return objectSelection;

  const markType = state.schema.marks[mark];
  // `code_block` is the one text block in this schema declaring `marks: ""`,
  // so a schema refusal here always means the selection sits in code.
  return markType && marksApplyTo(state, markType) ? null : "code-block";
}

function textblocksInSelection(state: EditorState): PMNode[] {
  const targets: PMNode[] = [];
  const { from, to } = state.selection;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) targets.push(node);
  });
  return targets;
}

/**
 * Mirrors prosemirror-commands' internal `markApplies`: a mark can be toggled
 * when any node in the selection accepts it. Ported rather than reached for
 * through `editor.can()` so the whole matrix stays derivable from editor state.
 */
function marksApplyTo(state: EditorState, markType: MarkType): boolean {
  for (const range of state.selection.ranges) {
    const { $from, $to } = range;
    let applies = $from.depth === 0 && state.doc.type.allowsMarkType(markType);
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
      if (applies) return false;
      applies = node.inlineContent && node.type.allowsMarkType(markType);
      return true;
    });
    if (applies) return true;
  }
  return false;
}

function everyControlBlockedBy(reason: ToolbarBlockedReason): ToolbarControlStates {
  return Object.fromEntries(
    CONTROL_IDS.map((id) => [id, { active: false, blockedBy: reason }]),
  ) as ToolbarControlStates;
}
