/** Plan a forward revert as grouped ordinary writes addressed to the model view's Yjs items. */

import type { DocumentRevision } from "@meridian/contracts";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import type { Schema } from "prosemirror-model";
import type * as Y from "yjs";
import { windowOf } from "../apply/echo.js";
import type { ResolvedEdit, ResolvedInlineReplacement } from "../apply/types.js";
import { align } from "../diff/align.js";
import { rebase } from "../diff/merge.js";
import { blockKey, buildSide, diffKeys, type Side } from "../diff/tokens.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import { documentRevision } from "../resolver/resolve.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import { semanticIrForEdits } from "../semantic-edit-ir-builder.js";
import type { EditEffect } from "../undo/forward-inverse.js";
import {
  alignmentFromKeys,
  type IdentitySide,
  identitySide,
  inverseAligner,
  type TokenEvidence,
  tokenEvidence,
} from "./revert-alignment.js";

export interface RevertPassage {
  edits: ResolvedEdit[];
  targets: number[];
  ir: SemanticEditIRV1;
}

export interface RevertPlanInput {
  schema: Schema;
  /** Exact post-N and pre-N cuts of N's source room. */
  a: Y.Doc;
  b: Y.Doc;
  /** Model view, including this reply's own writes; live refs must not escape this call. */
  view: Y.Doc;
  effect: EditEffect;
  documentId: string;
  file: string;
  inputRevision?: DocumentRevision;
}

interface PlannedEdit {
  edit: ResolvedEdit;
  targets: number[];
  oldBlocks: number[];
  newBlocks: number[];
}

/** Pure planning: the caller owns acceptance, application, capture and persistence. */
export function planRevert(input: RevertPlanInput): RevertPassage[] {
  const a = identitySide(input.a, input.schema, input.effect.inserted);
  const b = identitySide(input.b, input.schema, input.effect.deleted);
  const view = identitySide(input.view, input.schema, input.effect.inserted);
  const merged = rebase(input.schema, a.side.blocks, view.side.blocks, b.side.blocks, {
    alignDraft: inverseAligner(a.evidence, b.evidence),
  });
  const model = yProsemirrorModel(input.schema);
  const refs = model.getBlocks(input.view);
  const evidence = tokenEvidence(view.side, view.evidence);
  const target = buildSide(removeEmptiedParagraphs(a, view, merged.blocks));
  const sourceKeys = view.side.toks.map((token, index) =>
    evidence[index].touched ? `excluded:${index}` : token.key,
  );
  const alignment = alignmentFromKeys(
    view.side,
    target,
    sourceKeys,
    target.toks.map((token) => token.key),
  );
  const targetToSource = new Int32Array(target.toks.length).fill(-1);
  alignment.pos.forEach((to, from) => {
    if (to >= 0) targetToSource[to] = from;
  });
  const reused = pairParents(view.side, target, targetToSource);
  const kept = new Set(reused.filter((index) => index >= 0));
  const planned: PlannedEdit[] = [];
  const common = { documentId: input.documentId, file: input.file };
  let anchor: number | undefined;
  let insertionRun = {};
  for (let j = 0; j < target.blocks.length; j++) {
    const i = reused[j];
    const next = target.blocks[j];
    if (i < 0) {
      planned.push({
        edit: {
          ...common,
          kind: "insert",
          after: anchor === undefined ? undefined : refs[anchor],
          insertionRun,
          blocks: [next],
          newText: next.textContent,
        },
        targets: [anchor ?? -1],
        oldBlocks: [],
        newBlocks: [j],
      });
      continue;
    }
    const before = view.side.blocks[i];
    const replacements = inlineReplacements(view.side, i, target, j, targetToSource, evidence);
    if (replacements === null) {
      if (!before.eq(next)) {
        planned.push({
          edit: { ...common, kind: "block", block: refs[i], replacement: next },
          targets: [i],
          oldBlocks: [i],
          newBlocks: [j],
        });
      }
    } else if (replacements.length) {
      planned.push({
        edit: {
          ...common,
          kind: "textRanges",
          block: refs[i],
          replacements,
          output: replacementOutput(before.textContent, replacements),
        },
        targets: [i],
        oldBlocks: [i],
        newBlocks: [j],
      });
    }
    anchor = i;
    insertionRun = {};
  }
  // Inserts must precede deletes: the last block clears instead of disappearing, and no insert
  // may anchor on a tombstone. Every anchor above is a reused (never deleted) view block.
  for (let i = 0; i < refs.length; i++)
    if (!kept.has(i))
      planned.push({
        edit: { ...common, kind: "delete", block: refs[i] },
        targets: [i],
        oldBlocks: [i],
        newBlocks: [],
      });

  const groups = groupPassages(planned, view.side, target, alignment.pos, alignment.hunks);
  const inputRevision =
    input.inputRevision ?? (documentRevision({ model, doc: input.view }) as DocumentRevision);
  return groups.map((group) => {
    const edits = group.map((index) => planned[index].edit);
    return {
      edits,
      targets: [...new Set(group.flatMap((index) => planned[index].targets))].sort((a, b) => a - b),
      ir: semanticIrForEdits({ documentId: input.documentId, inputRevision, model, edits }),
    };
  });
}

/** A writer's split must not leave the erased N-only sentence as an empty paragraph. */
function removeEmptiedParagraphs(
  a: IdentitySide,
  view: IdentitySide,
  blocks: Side["blocks"],
): Side["blocks"] {
  if (!blocks.some((block) => block.type.name === "paragraph" && block.content.size === 0))
    return blocks;
  const target = buildSide(blocks);
  const alignment = align(view.side, target);
  const sourceOf = new Int32Array(target.toks.length).fill(-1);
  alignment.pos.forEach((to, from) => {
    if (to >= 0) sourceOf[to] = from;
  });
  const parents = target.starts.slice(0, -1).map((start) => {
    const from = sourceOf[start];
    return from >= 0 ? view.side.blockOf[from] : -1;
  });
  const allInserted = (token: TokenEvidence) =>
    token.changed.length > 0 && token.changed.every(Boolean);
  const inserted = tokenEvidence(view.side, view.evidence).map(
    (token, index) => view.side.toks[index].kind === "text" && allInserted(token),
  );
  const aEvidence = tokenEvidence(a.side, a.evidence);
  // A split, or a rebuilt V, may have copied N's text into fresh items. Recover only
  // its content correspondence here; this never changes the inverse's identity alignment.
  align(a.side, view.side).pos.forEach((to, from) => {
    if (to >= 0 && a.side.toks[from].kind === "text" && allInserted(aEvidence[from]))
      inserted[to] = true;
  });
  return blocks.filter((block, j) => {
    if (block.type.name !== "paragraph" || block.content.size !== 0) return true;
    const i = parents[j];
    if (i < 0 || view.side.blocks[i].content.size === 0) return true;
    for (let k = view.side.starts[i] + 1; k < view.side.starts[i + 1]; k++) {
      if (!inserted[k]) return true;
    }
    return false;
  });
}

/** A split keeps its first eligible parent; a join keeps the first parent's surviving spans. */
function pairParents(source: Side, target: Side, targetToSource: Int32Array): number[] {
  // Block-start keys repeat for every paragraph. A matched start alone must not steal
  // the parent of a later block whose words still survive (restoring blocks before an end).
  const candidates = target.blocks.map((_, j) => {
    const words: number[] = [];
    for (let token = target.starts[j]; token < target.starts[j + 1]; token++) {
      const from = targetToSource[token];
      if (from >= 0 && target.toks[token].kind !== "block") words.push(source.blockOf[from]);
    }
    return words;
  });
  const reserved = new Set(candidates.flat());
  const nextParent = new Array<number>(target.blocks.length).fill(Number.POSITIVE_INFINITY);
  let bound = Number.POSITIVE_INFINITY;
  for (let j = target.blocks.length - 1; j >= 0; j--) {
    nextParent[j] = bound;
    for (const candidate of candidates[j]) bound = Math.min(bound, candidate);
  }
  const emptyParents = new Map<string, { indices: number[]; cursor: number }>();
  source.blocks.forEach((node, index) => {
    if (node.content.size !== 0) return;
    const key = blockKey(node);
    const queue = emptyParents.get(key) ?? { indices: [], cursor: 0 };
    queue.indices.push(index);
    emptyParents.set(key, queue);
  });
  let previous = -1;
  return target.blocks.map((node, j) => {
    const start = targetToSource[target.starts[j]];
    const fallback = start >= 0 ? source.blockOf[start] : -1;
    // A retained empty paragraph is a real parent, not an interchangeable block-start
    // token from an N-only paragraph whose text this revert removes.
    const queue = node.content.size === 0 ? emptyParents.get(blockKey(node)) : undefined;
    if (queue) {
      while (queue.cursor < queue.indices.length && queue.indices[queue.cursor] <= previous)
        queue.cursor++;
    }
    const empty = queue?.indices[queue.cursor] ?? -1;
    const options = candidates[j].length
      ? candidates[j]
      : empty >= 0 && empty < nextParent[j]
        ? [empty]
        : reserved.has(fallback)
          ? []
          : [fallback];
    const i = options.find(
      (candidate) => candidate > previous && source.blocks[candidate].sameMarkup(node),
    );
    if (i === undefined) return -1;
    previous = i;
    return i;
  });
}

/** Inline offsets are exact, not a new content diff that could select another equal word. */
function inlineReplacements(
  source: Side,
  i: number,
  target: Side,
  j: number,
  targetToSource: Int32Array,
  evidence: TokenEvidence[],
): ResolvedInlineReplacement[] | null {
  const before = source.blocks[i];
  const after = target.blocks[j];
  if (!before.isTextblock || !after.isTextblock || before.type.name === "code_block") return null;
  let textOnly = true;
  before.forEach((node) => {
    if (!node.isText) textOnly = false;
  });
  after.forEach((node) => {
    if (!node.isText) textOnly = false;
  });
  if (!textOnly) return null;
  const result: ResolvedInlineReplacement[] = [];
  let from = 0;
  let to = 0;
  let targetOffset = 0;
  const characterKeys = (node: typeof before): string[] => {
    const keys: string[] = [];
    node.forEach((child) => {
      const marks = JSON.stringify(child.marks.map((mark) => mark.toJSON()));
      for (const char of (child.text ?? "").split("")) keys.push(JSON.stringify([char, marks]));
    });
    return keys;
  };
  const sourceCharacters = characterKeys(before);
  const targetCharacters = characterKeys(after);
  for (let k = source.starts[i]; k < source.starts[i + 1]; k++) {
    const token = source.toks[k];
    if (token.kind !== "text") continue;
    evidence[k].changed.forEach((changed, offset) => {
      if (changed)
        sourceCharacters[evidence[k].from + offset] = `excluded:${evidence[k].from + offset}`;
    });
  }
  const gap = (end: number, targetEnd: number) => {
    let x = from;
    let y = to;
    let gapX = from;
    let gapY = to;
    const flush = () => {
      if (gapX !== x || gapY !== y)
        result.push({ span: { start: gapX, end: x }, content: after.content.cut(gapY, y) });
    };
    for (const [operation, count] of diffKeys(
      sourceCharacters.slice(from, end),
      targetCharacters.slice(to, targetEnd),
    )) {
      if (operation === DIFF_EQUAL) {
        flush();
        x += count;
        y += count;
        gapX = x;
        gapY = y;
      } else if (operation === DIFF_DELETE) x += count;
      else y += count;
    }
    flush();
  };
  for (let k = target.starts[j]; k < target.starts[j + 1]; k++) {
    const token = target.toks[k];
    if (token.kind !== "text") continue;
    const length = token.ws.length + token.core.length;
    const matched = targetToSource[k];
    if (matched >= source.starts[i] && matched < source.starts[i + 1]) {
      const old = evidence[matched];
      const oldToken = source.toks[matched];
      if (oldToken.kind !== "text") throw new Error("Revert matched incompatible inline tokens");
      // Pair the core first. Leading whitespace is independently diffed, excluding N's
      // inserted characters even when the destination contains an equal-looking space.
      const oldWhitespace = sourceCharacters.slice(old.from, old.from + oldToken.ws.length);
      const newWhitespace = targetCharacters.slice(targetOffset, targetOffset + token.ws.length);
      let x = 0;
      let y = 0;
      for (const [operation, count] of diffKeys(oldWhitespace, newWhitespace)) {
        if (operation === DIFF_EQUAL) {
          gap(old.from + x, targetOffset + y);
          from = old.from + x + count;
          to = targetOffset + y + count;
        }
        if (operation !== DIFF_INSERT) x += count;
        if (operation !== DIFF_DELETE) y += count;
      }
      gap(old.from + oldToken.ws.length, targetOffset + token.ws.length);
      from = old.to;
      to = targetOffset + length;
    }
    targetOffset += length;
  }
  gap(before.content.size, after.content.size);
  return result;
}

function replacementOutput(text: string, replacements: ResolvedInlineReplacement[]): string {
  let at = replacements[0].span.start;
  let output = "";
  for (const replacement of replacements) {
    output += text.slice(at, replacement.span.start);
    output += replacement.content.textBetween(0, replacement.content.size, "");
    at = replacement.span.end;
  }
  return output;
}

/** Window overlap joins passages; cross-block correspondences and moves join their dependencies. */
function groupPassages(
  planned: PlannedEdit[],
  source: Side,
  target: Side,
  pos: Int32Array,
  hunks: ReturnType<typeof alignmentFromKeys>["hunks"],
): number[][] {
  const parents = planned.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const join = (indices: number[]) => {
    const first = indices[0];
    if (first === undefined) return;
    for (const i of indices) parents[root(i)] = root(first);
  };
  const oldEdits = source.blocks.map(() => [] as number[]);
  const newEdits = target.blocks.map(() => [] as number[]);
  planned.forEach((entry, index) => {
    for (const block of entry.oldBlocks) oldEdits[block].push(index);
    for (const block of entry.newBlocks) newEdits[block].push(index);
  });
  const windows = planned
    .map((entry, index) => ({
      index,
      window: windowOf(entry.targets, source.blocks.length),
    }))
    .filter((entry) => entry.window.length)
    .sort((a, b) => a.window[0] - b.window[0]);
  let end = -2;
  let previous = -1;
  for (const entry of windows) {
    if (entry.window[0] <= end + 1) join([previous, entry.index]);
    end = Math.max(end, entry.window[entry.window.length - 1]);
    previous = entry.index;
  }
  pos.forEach((to, from) => {
    if (to >= 0) join([...oldEdits[source.blockOf[from]], ...newEdits[target.blockOf[to]]]);
  });
  for (const hunk of hunks) {
    const edits = new Set<number>();
    for (let from = hunk.from; from < hunk.to; from++)
      for (const edit of oldEdits[source.blockOf[from]]) edits.add(edit);
    for (let to = hunk.sfrom; to < hunk.sfrom + hunk.ins.length; to++)
      for (const edit of newEdits[target.blockOf[to]]) edits.add(edit);
    join([...edits]);
  }
  // A move has no monotone token correspondence. Keep both ends atomic even far apart.
  const removedByContent = new Map<string, number[]>();
  planned.forEach((entry, index) => {
    if (entry.edit.kind !== "delete") return;
    const key = blockKey(source.blocks[entry.oldBlocks[0]]);
    const list = removedByContent.get(key) ?? [];
    list.push(index);
    removedByContent.set(key, list);
  });
  planned.forEach((entry, index) => {
    if (entry.edit.kind !== "insert") return;
    for (const block of entry.newBlocks)
      join([index, ...(removedByContent.get(blockKey(target.blocks[block])) ?? [])]);
  });
  const groups = new Map<number, number[]>();
  planned.forEach((_, index) => {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  return [...groups.values()].sort(
    (a, b) =>
      Math.min(...a.flatMap((i) => planned[i].targets)) -
      Math.min(...b.flatMap((i) => planned[i].targets)),
  );
}
