/**
 * Removed live text, shown inline in the draft as a read-only struck-through
 * mark. The text is a ProseMirror widget DOM node: it is never part of the
 * Y.Doc or the TipTap document, so it cannot be typed into, saved, copied
 * out of the editor, or selected into the document.
 *
 * This file owns the pure grouping and collapse rules (`planRemovals`) and the
 * widget DOM (`createRemovalElement`). `decorations.ts` decides where each
 * plan lands; the extension supplies the click handlers.
 */
import { plural, t } from "@lingui/core/macro";
import type { RemovalKind } from "./model";

/** A removal longer than this many characters folds to a one-line label until clicked. */
export const REMOVAL_COLLAPSE_CHARS = 200;

export const REMOVAL_CLASS = "meridian-review-removal";
export const REMOVAL_BLOCK_CLASS = "meridian-review-removal-block";
export const REMOVAL_WRITER_CLASS = "meridian-review-removal-writer";
/** Every removed stretch is unattributed: the fold wears no author's colour. */
export const REMOVAL_UNATTRIBUTED_CLASS = "meridian-review-removal-unattributed";
export const REMOVAL_TOGGLE_CLASS = "meridian-review-removal-toggle";
/** The removal sits before punctuation or a line end, so it keeps no air after it. */
export const REMOVAL_TIGHT_CLASS = "meridian-review-removal-tight";
export const REMOVAL_TEXT_CLASS = "meridian-review-removal-text";
export const REMOVAL_TEXT_WRITER_CLASS = "meridian-review-removal-text-writer";
export const REMOVAL_TEXT_UNATTRIBUTED_CLASS = "meridian-review-removal-text-unattributed";

/** A stretch of removed text and who took it out; `unattributed` when the server could not say. */
export interface RemovalSegment {
  text: string;
  kind: RemovalKind;
}

/** One removal widget: the live text one or more adjacent hunks took out at a single position. */
export interface RemovalPlan {
  /** Stable across preview refetches (hunk ids are positional, so they are not used). */
  identity: string;
  position: number;
  /** Sits between blocks and renders as paragraphs, rather than inside a text block. */
  block: boolean;
  /** Followed by punctuation or the end of the line: no gap after the struck text. */
  tight: boolean;
  /**
   * The writer's only when every segment is, unattributed only when every
   * segment is, the AI's otherwise; colours the fold, since the text carries its own.
   */
  kind: RemovalKind;
  /** Each paragraph is its removed stretches in order, each in its author's colour. */
  paragraphs: RemovalSegment[][];
  hunkIds: string[];
  operationIds: string[];
}

/** One removal before grouping: a single hunk's deleted text at its resolved position. */
export interface RemovalInput {
  position: number;
  block: boolean;
  segments: RemovalSegment[];
  tight: boolean;
  hunkId: string;
  operationIds: string[];
}

/**
 * Merge consecutive block-level removals that land at the same position into
 * one plan, so three deleted paragraphs read "3 paragraphs removed". Inline
 * removals stay one plan each.
 */
export function planRemovals(inputs: readonly RemovalInput[]): RemovalPlan[] {
  const plans: RemovalPlan[] = [];
  for (const input of inputs) {
    const segments = input.segments.filter((segment) => segment.text !== "");
    if (
      segments
        .map((segment) => segment.text)
        .join("")
        .trim() === ""
    )
      continue;
    const last = plans[plans.length - 1];
    if (input.block && last?.block && last.position === input.position) {
      last.paragraphs.push(segments);
      last.hunkIds.push(input.hunkId);
      for (const id of input.operationIds) {
        if (!last.operationIds.includes(id)) last.operationIds.push(id);
      }
      last.kind = planKind(last.paragraphs);
      last.identity = removalIdentity(last.operationIds, last.paragraphs);
      continue;
    }
    plans.push({
      identity: removalIdentity(input.operationIds, [segments]),
      position: input.position,
      block: input.block,
      tight: input.tight,
      kind: planKind([segments]),
      paragraphs: [segments],
      hunkIds: [input.hunkId],
      operationIds: [...input.operationIds],
    });
  }
  return plans;
}

function paragraphText(paragraph: readonly RemovalSegment[]): string {
  return paragraph.map((segment) => segment.text).join("");
}

function planKind(paragraphs: readonly RemovalSegment[][]): RemovalKind {
  const every = (kind: RemovalKind) =>
    paragraphs.every((paragraph) => paragraph.every((segment) => segment.kind === kind));
  return every("writer") ? "writer" : every("unattributed") ? "unattributed" : "agent";
}

function removalIdentity(
  operationIds: readonly string[],
  paragraphs: readonly RemovalSegment[][],
): string {
  const texts = paragraphs.map(paragraphText);
  const chars = texts.reduce((total, text) => total + text.length, 0);
  return `${operationIds.join("+")}:${texts.length}:${chars}:${texts[0]?.slice(0, 24) ?? ""}`;
}

export function removalCharCount(plan: RemovalPlan): number {
  return plan.paragraphs.reduce((total, paragraph) => total + paragraphText(paragraph).length, 0);
}

export function isCollapsible(plan: RemovalPlan): boolean {
  return removalCharCount(plan) > REMOVAL_COLLAPSE_CHARS;
}

/**
 * "1 paragraph removed", "3 paragraphs removed", or "42 words removed" for a long
 * span inside one, in the active locale. Called when the widget is drawn, so the
 * plan stays free of copy.
 */
export function removalLabel(plan: RemovalPlan): string {
  if (plan.block) {
    const count = plan.paragraphs.length;
    return plural(count, { one: "# paragraph removed", other: "# paragraphs removed" });
  }
  const words = plan.paragraphs.map(paragraphText).join(" ").split(/\s+/).filter(Boolean).length;
  return plural(words, { one: "# word removed", other: "# words removed" });
}

export interface RemovalHandlers {
  /**
   * A click on a removal: its change becomes the focused one, and a click on the
   * fold toggles that removal open or closed. `keyboard` is true when the fold
   * was activated from the keyboard, so focus can follow it to the rebuilt widget.
   */
  activate: (operationId: string, toggleIdentity: string | null, keyboard: boolean) => void;
  /**
   * A click on the struck text: the caret goes to where the removal stands, on
   * the side of it that was clicked, so typing lands there. The removal itself
   * stays outside the document and cannot be selected into.
   */
  placeCaret: (removalIdentity: string, side: -1 | 1) => void;
}

export interface RemovalRenderOptions {
  focused: boolean;
  /** The change arrived while the writer was reviewing; it pulses once. */
  pulsed: boolean;
  expanded: boolean;
  /** Put keyboard focus on the fold once this widget is in the document. */
  refocusToggle: boolean;
  handlers: RemovalHandlers;
  hunkAttr: string;
  operationAttr: string;
}

/** Build the widget DOM. Non-editable and unselectable; clicking focuses the change or toggles a fold. */
export function createRemovalElement(
  doc: Document,
  plan: RemovalPlan,
  options: RemovalRenderOptions,
): HTMLElement {
  const collapsible = isCollapsible(plan);
  const folded = collapsible && !options.expanded;
  const root: HTMLElement = doc.createElement(plan.block ? "div" : "span");
  root.className = [
    REMOVAL_CLASS,
    plan.block ? REMOVAL_BLOCK_CLASS : "",
    plan.tight && !plan.block ? REMOVAL_TIGHT_CLASS : "",
    plan.kind === "writer" ? REMOVAL_WRITER_CLASS : "",
    plan.kind === "unattributed" ? REMOVAL_UNATTRIBUTED_CLASS : "",
    options.focused ? "meridian-review-emphasized" : "",
    options.pulsed ? "meridian-review-arrived" : "",
  ]
    .filter(Boolean)
    .join(" ");
  root.setAttribute("contenteditable", "false");
  root.setAttribute(options.hunkAttr, plan.hunkIds.join(" "));
  root.setAttribute(options.operationAttr, plan.operationIds.join(" "));

  if (collapsible) {
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = REMOVAL_TOGGLE_CLASS;
    toggle.setAttribute("aria-expanded", folded ? "false" : "true");
    toggle.textContent = folded ? removalLabel(plan) : t`Hide removed text`;
    root.append(toggle);
    if (options.refocusToggle) queueMicrotask(() => toggle.focus());
  }
  if (!folded) {
    for (const segments of plan.paragraphs) {
      const struck = segments.map((segment) => {
        const del = doc.createElement("del");
        del.className = [
          REMOVAL_TEXT_CLASS,
          segment.kind === "writer" ? REMOVAL_TEXT_WRITER_CLASS : "",
          segment.kind === "unattributed" ? REMOVAL_TEXT_UNATTRIBUTED_CLASS : "",
        ]
          .filter(Boolean)
          .join(" ");
        del.textContent = segment.text;
        return del;
      });
      if (plan.block) {
        const paragraph = doc.createElement("p");
        paragraph.append(...struck);
        root.append(paragraph);
      } else {
        root.append(...struck);
      }
    }
  }
  // Keep the editor's caret and focus where the writer left them. The change is
  // chosen on click, not on press: choosing rebuilds this widget, and a rebuild
  // between press and release would swallow the click.
  root.addEventListener("mousedown", (event) => event.preventDefault());
  root.addEventListener("click", (event) => {
    const [operationId] = plan.operationIds;
    if (!operationId) return;
    const onToggle =
      event.target instanceof Element && event.target.closest(`.${REMOVAL_TOGGLE_CLASS}`);
    // A pointer click on the struck text (not the fold, not Enter on it). The side
    // is read before activating: activating rebuilds this widget, and a detached
    // one has no box to measure.
    const side = !onToggle && event.detail > 0 ? clickedSide(root, event, plan.block) : null;
    options.handlers.activate(operationId, onToggle ? plan.identity : null, event.detail === 0);
    if (side !== null) options.handlers.placeCaret(plan.identity, side);
  });
  return root;
}

/** Which side of the removal a click landed on: left or upper half is before it, the rest after. */
function clickedSide(root: HTMLElement, event: MouseEvent, block: boolean): -1 | 1 {
  const rect = root.getBoundingClientRect();
  return block
    ? event.clientY < rect.top + rect.height / 2
      ? -1
      : 1
    : event.clientX < rect.left + rect.width / 2
      ? -1
      : 1;
}

export const BAR_SLOT_CLASS = "meridian-review-bar-slot";
export const BAR_SLOT_ATTR = "data-review-bar-slot";

/**
 * The empty block the focused change's bar is drawn into when the margin is too
 * narrow for it. It lives in the editor's flow, so it pushes the text after the
 * change down and can never cover any. The bar itself is React's, portalled in.
 */
export function createBarSlotElement(doc: Document): HTMLElement {
  const slot = doc.createElement("div");
  slot.className = BAR_SLOT_CLASS;
  slot.setAttribute("contenteditable", "false");
  slot.setAttribute(BAR_SLOT_ATTR, "");
  return slot;
}
