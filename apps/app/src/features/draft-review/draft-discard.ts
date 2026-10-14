/**
 * Local Discard: the writer's reject of one change, or of the whole draft, is an edit of their own editor.
 *
 * It writes the reverted text into the `prosemirror` fragment with `writeBlocks` (per-word Yjs edits), not
 * through a ProseMirror transaction: y-prosemirror would write a transaction as one prefix/suffix diff and
 * retype a peer's concurrent deletion in the middle of the paragraph. The Yjs transaction carries
 * editor's own undo origin (`undoOriginOf`, so another editor on the same room never undoes it), with `stopCapturing()` on both sides so a
 * Discard is exactly one Ctrl+Z step, apart from the typing before and after it. Nothing is sent to the
 * server: the draft room syncs the edit like any other.
 *
 * A command names a change by the frame its list was drawn from. The editor may have moved on since
 * (typing inside the debounce, a peer's write), so the change is found again in a fresh projection by the
 * Yjs position pinned at projection time plus its content hash; a change that cannot be found both ways is
 * a no-op, because an occurrence-ranked id alone is not identity (two identical edits swap ranks).
 */
import {
  applySpanPatches,
  composeGroups,
  type ReviewGroup,
  type ReviewProjection,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import type { Editor } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { contentHashOf } from "@/core/editor/extensions/inline-review";
import { undoOriginOf } from "@/core/editor/extensions/UndoOwnershipExtension";
import {
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "@/core/editor/relative-position-runtime";
import type { ReviewFrame } from "./review-frame";

/** What a Discard writes into: the draft's fragment and the history that should record it. */
export interface DiscardTarget {
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  schema: Schema;
  undo: Y.UndoManager | null;
  /** The transaction origin `undo` tracks for this writer's own edits. */
  origin: unknown;
}

/** Revert these groups (or every change) in the fragment, as one undoable step. */
export function writeDiscard(
  target: DiscardTarget,
  projection: ReviewProjection,
  which: readonly string[] | "all",
): void {
  const blocks =
    which === "all"
      ? projection.diff.base.blocks
      : applySpanPatches(
          projection.diff.draft.blocks,
          composeGroups(target.schema, projection, which, "discard"),
          "draft",
        );
  const { undo } = target;
  const { origin } = target;
  undo?.stopCapturing();
  target.doc.transact(() => {
    writeBlocks(target.fragment, target.schema, blocks);
  }, origin);
  undo?.stopCapturing();
}

/**
 * The group `id` of an older projection, found in `fresh`: the one holding the pinned position whose
 * content hash is the same. Same hash alone, or the position alone, is not the change the writer clicked.
 */
export function refindGroup(
  fresh: Pick<ReviewProjection, "groups">,
  id: string,
  position: number | null,
): ReviewGroup | null {
  if (position === null) return null;
  const wanted = contentHashOf(id);
  let best: { group: ReviewGroup; distance: number } | null = null;
  for (const group of fresh.groups) {
    if (contentHashOf(group.id) !== wanted) continue;
    const marks = group.hunks.map(
      (hunk) => hunk.inserted ?? { from: hunk.anchor, to: hunk.anchor },
    );
    const from = Math.min(...marks.map((mark) => mark.from));
    const to = Math.max(...marks.map((mark) => mark.to));
    const distance = position < from ? from - position : position > to ? position - to : 0;
    if (!best || distance < best.distance) best = { group, distance };
  }
  // The pin is the change's first mark; a peer's insert right at it moves the mark by at most its own length.
  return best && best.distance === 0 ? best.group : null;
}

export interface ReviewEditorHandle {
  editor: Editor;
  /** The projection the editor holds now, and a recompute from its current state. */
  current(): ReviewFrame | null;
  projectNow(): ReviewFrame | null;
}

function targetOf(editor: Editor): DiscardTarget | null {
  const runtime = relativePositionRuntimeFromState(editor.state);
  if (!runtime) return null;
  const undo: Y.UndoManager | null = yUndoPluginKey.getState(editor.state)?.undoManager ?? null;
  const origin = undoOriginOf(undo);
  if (!undo || !origin) return null;
  return { doc: runtime.yDoc, fragment: runtime.yFragment, schema: editor.schema, undo, origin };
}

/** A projection of exactly what the editor shows now. */
function freshProjection(handle: ReviewEditorHandle): ReviewFrame | null {
  const held = handle.current();
  return held && held.doc === handle.editor.state.doc ? held : handle.projectNow();
}

export type DiscardResult = "discarded" | "stale";

/** Discard one change, named by the projection the writer's list was drawn from. */
export function discardChange(
  handle: ReviewEditorHandle,
  from: ReviewFrame,
  id: string,
): DiscardResult {
  const { editor } = handle;
  const target = editor.isDestroyed ? null : targetOf(editor);
  if (!target) return "stale";
  const fresh = freshProjection(handle);
  if (!fresh) return "stale";
  let group: ReviewGroup | null;
  if (fresh === from) {
    group = fresh.groups.find((candidate) => candidate.id === id) ?? null;
  } else {
    const pin = from.pins.get(id);
    const bound = relativePositionRuntimeFromState(editor.state);
    group = refindGroup(fresh, id, pin && bound ? resolveRelativePosition(bound, pin) : null);
  }
  if (!group) return "stale";
  writeDiscard(target, fresh, [group.id]);
  return "discarded";
}

/** Discard every change: one edit that sets the draft to its base. */
export function discardAll(handle: ReviewEditorHandle): DiscardResult {
  const { editor } = handle;
  const target = editor.isDestroyed ? null : targetOf(editor);
  const fresh = freshProjection(handle);
  if (!target || !fresh) return "stale";
  writeDiscard(target, fresh, "all");
  return "discarded";
}

/** Undo the last step of the editor's surface history: the Discard just made there. */
export function undoDiscard(handle: ReviewEditorHandle): void {
  const { editor } = handle;
  if (editor.isDestroyed) return;
  yUndoPluginKey.getState(editor.state)?.undoManager?.undo();
}
