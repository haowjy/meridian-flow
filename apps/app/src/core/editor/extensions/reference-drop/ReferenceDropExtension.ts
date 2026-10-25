/** Turns Meridian tree-row drags into the references a writing surface already inserts. */

import { Extension } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Fragment } from "@tiptap/pm/model";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { tableDropDecision } from "../../table-drop";
import { DropCaretView } from "../drop-caret";

export const MERIDIAN_ENTRIES_MIME = "application/x-meridian-entries";

export type ReferenceDropEntry = Readonly<{
  ref: Readonly<{ kind: "file" | "folder"; id: string }>;
}>;

export type ReferenceDropVerdict =
  | { kind: "accept"; label: string }
  | { kind: "refuse"; reason: ReferenceDropRefusalReason; label: string };

export type ReferenceDropRefusalReason = "unavailable" | "invalid-landing";

export type ReferenceDropOptions = {
  activeDrag: () => readonly ReferenceDropEntry[] | null;
  /** Resolves identities through the host's live `@` catalog and builds its exact node shape. */
  content: (schema: Schema, entries: readonly ReferenceDropEntry[]) => readonly PMNode[] | null;
  label: (kind: "accept" | ReferenceDropRefusalReason) => string;
  showHint: (
    owner: string,
    verdict: ReferenceDropVerdict,
    point: { clientX: number; clientY: number },
  ) => void;
  clearHint: (owner: string) => void;
};

let ownerSequence = 0;

export function draggingMeridianEntries(event: Pick<DragEvent, "dataTransfer">): boolean {
  const transfer = event.dataTransfer;
  return Boolean(
    transfer &&
      transfer.files.length === 0 &&
      Array.from(transfer.types).includes(MERIDIAN_ENTRIES_MIME),
  );
}

type AcceptedPlan = { kind: "accept"; label: string; pos: number; content: Fragment };
type PreparedPlan =
  | AcceptedPlan
  | { kind: "refuse"; reason: ReferenceDropRefusalReason; label: string };

function basicWordCharacter(value: string): boolean {
  return /[\p{L}\p{M}\p{N}_]/u.test(value);
}

function characterAt(view: EditorView, pos: number): string {
  return view.state.doc.textBetween(pos, pos + 1, "\0", "\0");
}

function wordCharacterAt(view: EditorView, pos: number, start: number, end: number): boolean {
  const character = characterAt(view, pos);
  if (basicWordCharacter(character)) return true;
  return (
    pos > start &&
    pos + 1 < end &&
    /['’\-‐‑]/u.test(character) &&
    basicWordCharacter(characterAt(view, pos - 1)) &&
    basicWordCharacter(characterAt(view, pos + 1))
  );
}

function identityLink(node: PMNode) {
  return node.marks.find((mark) => mark.type.name === "link" && mark.attrs.ref !== null);
}

function snapOutsideIdentityLink(view: EditorView, pos: number): number {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return pos;
  const start = pos - $pos.parentOffset;
  let runStart = 0;
  let runEnd = 0;
  let runLink: ReturnType<typeof identityLink>;
  let landingSpan: { start: number; end: number } | null = null;
  $pos.parent.forEach((node, offset) => {
    const link = identityLink(node);
    if (link && runLink?.eq(link) && offset === runEnd) {
      runEnd += node.nodeSize;
      return;
    }
    if (runLink && $pos.parentOffset > runStart && $pos.parentOffset < runEnd)
      landingSpan = { start: runStart, end: runEnd };
    runLink = link;
    runStart = offset;
    runEnd = offset + node.nodeSize;
  });
  if (runLink && $pos.parentOffset > runStart && $pos.parentOffset < runEnd)
    landingSpan = { start: runStart, end: runEnd };
  return landingSpan
    ? pos - (start + landingSpan.start) <= start + landingSpan.end - pos
      ? start + landingSpan.start
      : start + landingSpan.end
    : pos;
}

function snapOutsideAtom(
  view: EditorView,
  pos: number,
  point: { clientX: number; clientY: number },
): number {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return pos;
  const candidates = [
    { node: $pos.nodeAfter, start: pos },
    { node: $pos.nodeBefore, start: pos - ($pos.nodeBefore?.nodeSize ?? 0) },
  ];
  for (const { node, start } of candidates) {
    if (!node?.isInline || !node.isAtom || node.isText) continue;
    const dom = view.nodeDOM(start);
    if (!(dom instanceof Element)) continue;
    const bounds = dom.getBoundingClientRect();
    if (
      point.clientX < bounds.left ||
      point.clientX > bounds.right ||
      point.clientY < bounds.top ||
      point.clientY > bounds.bottom
    )
      continue;
    return point.clientX <= (bounds.left + bounds.right) / 2 ? start : start + node.nodeSize;
  }
  return pos;
}

function unreferencedTextRunAt(
  view: EditorView,
  pos: number,
): { start: number; end: number } | null {
  const $pos = view.state.doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  const landing = $pos.parentOffset;
  let runStart: number | null = null;
  let runEnd = 0;
  let landingRun: { start: number; end: number } | null = null;
  $pos.parent.forEach((node, offset) => {
    if (node.isText && !identityLink(node)) {
      runStart ??= offset;
      runEnd = offset + node.nodeSize;
      return;
    }
    if (runStart !== null && landing > runStart && landing < runEnd)
      landingRun = { start: runStart, end: runEnd };
    runStart = null;
  });
  if (runStart !== null && landing > runStart && landing < runEnd)
    landingRun = { start: runStart, end: runEnd };
  if (!landingRun) return null;
  const parentStart = pos - landing;
  return { start: parentStart + landingRun.start, end: parentStart + landingRun.end };
}

/** A pointer inside an unreferenced word chooses its nearer edge. */
function snapToWordEdge(view: EditorView, pos: number): number {
  const run = unreferencedTextRunAt(view, pos);
  if (!run) return pos;
  const { start, end } = run;
  if (!wordCharacterAt(view, pos - 1, start, end) || !wordCharacterAt(view, pos, start, end))
    return pos;
  let before = pos;
  let after = pos;
  while (before > start && wordCharacterAt(view, before - 1, start, end)) before -= 1;
  while (after < end && wordCharacterAt(view, after, start, end)) after += 1;
  return pos - before <= after - pos ? before : after;
}

function landingAt(view: EditorView, event: DragEvent): number | null {
  const decision = tableDropDecision(view, { x: event.clientX, y: event.clientY });
  if (decision.kind === "refuse") return null;
  const raw =
    decision.kind === "snap"
      ? decision.pos
      : view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (raw === undefined) return null;
  const outsideReference = snapOutsideIdentityLink(view, snapOutsideAtom(view, raw, event));
  const pos = snapToWordEdge(view, outsideReference);
  const $pos = view.state.doc.resolve(pos);
  return $pos.parent.isTextblock && !$pos.parent.type.spec.code ? pos : null;
}

function spacedContent(view: EditorView, pos: number, nodes: readonly PMNode[]): Fragment | null {
  if (nodes.length === 0 || nodes.some((node) => !node.isInline)) return null;
  const $pos = view.state.doc.resolve(pos);
  const parent = $pos.parent;
  if (nodes.some((node) => !parent.type.allowsMarks(node.marks))) return null;

  const before = pos > $pos.start() ? characterAt(view, pos - 1) : "";
  const after = pos < $pos.end() ? characterAt(view, pos) : "";
  const content: PMNode[] = [];
  if (before && !/\s/u.test(before)) content.push(view.state.schema.text(" "));
  nodes.forEach((node, index) => {
    if (index > 0) content.push(view.state.schema.text(" "));
    content.push(node);
  });
  if (after && !/\s/u.test(after)) content.push(view.state.schema.text(" "));
  const fragment = Fragment.fromArray(content);
  return parent.canReplace($pos.index(), $pos.index(), fragment) ? fragment : null;
}

function prepare(view: EditorView, event: DragEvent, options: ReferenceDropOptions): PreparedPlan {
  const refuse = (reason: ReferenceDropRefusalReason): PreparedPlan => ({
    kind: "refuse",
    reason,
    label: options.label(reason),
  });
  const entries = options.activeDrag();
  if (!entries?.length) return refuse("unavailable");
  const nodes = options.content(view.state.schema, entries);
  if (!nodes || nodes.length !== entries.length) return refuse("unavailable");
  const pos = landingAt(view, event);
  if (pos === null) return refuse("invalid-landing");
  const content = spacedContent(view, pos, nodes);
  return content
    ? { kind: "accept", label: options.label("accept"), pos, content }
    : refuse("invalid-landing");
}

function referenceDropPlugin(options: ReferenceDropOptions): Plugin {
  const owner = `reference-drop:${++ownerSequence}`;
  const preparedEvents = new WeakMap<DragEvent, PreparedPlan | null>();
  const planAt = (view: EditorView, event: DragEvent): PreparedPlan | null => {
    if (preparedEvents.has(event)) return preparedEvents.get(event) ?? null;
    if (!view.editable || view.dragging || !draggingMeridianEntries(event)) {
      options.clearHint(owner);
      preparedEvents.set(event, null);
      return null;
    }
    const plan = prepare(view, event, options);
    options.showHint(owner, plan, event);
    preparedEvents.set(event, plan);
    return plan;
  };

  return new Plugin({
    view: (view) =>
      new DropCaretView(view, (current, event) => {
        const plan = planAt(current, event);
        return plan?.kind === "accept" ? plan.pos : null;
      }),
    props: {
      handleDrop(view, event) {
        if (!draggingMeridianEntries(event) || view.dragging || !view.editable) return false;
        event.preventDefault();
        event.stopPropagation();
        const plan = prepare(view, event, options);
        options.clearHint(owner);
        if (plan.kind === "refuse") return true;

        yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
        const transaction = closeHistory(view.state.tr).insert(plan.pos, plan.content);
        const end = transaction.mapping.map(plan.pos, 1);
        transaction.setSelection(TextSelection.create(transaction.doc, end));
        transaction.setMeta("uiEvent", "drop");
        view.dispatch(transaction.scrollIntoView());
        yUndoPluginKey.getState(view.state)?.undoManager.stopCapturing();
        view.dispatch(closeHistory(view.state.tr));
        view.focus();
        return true;
      },
      handleDOMEvents: {
        dragover(view, event) {
          const plan = planAt(view, event);
          if (!plan) return false;
          if (plan.kind === "accept") {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          } else if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
          return false;
        },
        dragleave(view, event) {
          if (!draggingMeridianEntries(event)) return false;
          const related = event.relatedTarget as Node | null;
          if (!related || !view.dom.contains(related)) options.clearHint(owner);
          return false;
        },
        dragend() {
          options.clearHint(owner);
          return false;
        },
      },
    },
  });
}

export const ReferenceDropExtension = Extension.create<ReferenceDropOptions>({
  name: "meridianReferenceDrop",

  addOptions: () => ({
    activeDrag: () => null,
    content: () => null,
    label: (kind) =>
      kind === "accept"
        ? "Mention"
        : kind === "unavailable"
          ? "Can’t mention that"
          : "Can’t mention there",
    showHint: () => {},
    clearHint: () => {},
  }),

  addProseMirrorPlugins() {
    return [referenceDropPlugin(this.options)];
  },
});
