/**
 * Removed base text, shown inline in the draft as a read-only red struck-through
 * widget. The text is a ProseMirror widget DOM node: it is never part of the
 * Y.Doc or the TipTap document, so it cannot be typed into, saved, copied
 * out of the editor, or selected into the document.
 *
 * This file owns the pure grouping and collapse rules (`planRemovals`) and the
 * widget DOM (`createRemovalElement`). `decorations.ts` decides where each
 * plan lands; the extension supplies the click handlers.
 */
import { plural, t } from "@lingui/core/macro";

/** A removal longer than this many characters folds to a one-line label until clicked. */
export const REMOVAL_COLLAPSE_CHARS = 200;

export const REMOVAL_CLASS = "meridian-review-removal";
export const REMOVAL_BLOCK_CLASS = "meridian-review-removal-block";
export const REMOVAL_TOGGLE_CLASS = "meridian-review-removal-toggle";
/** The removal sits before punctuation or a line end, so it keeps no air after it. */
export const REMOVAL_TIGHT_CLASS = "meridian-review-removal-tight";
export const REMOVAL_TEXT_CLASS = "meridian-review-removal-text";
/**
 * On a block removal: how many top-level blocks of the document it stands for.
 * Said by the widget, not counted from its children (a fold has none, an open one
 * also holds a button), so what reads a captured page counts its blocks right.
 */
export const REMOVED_BLOCKS_ATTR = "data-review-removed-blocks";
/** A long removal shown as its label only: its text is in the widget, hidden. */
export const REMOVAL_FOLDED_CLASS = "meridian-review-removal-folded";

/** One removal widget: the base text one or more adjacent hunks took out at a single position. */
export interface RemovalPlan {
  /** Stable across projections (positions are not part of it). */
  identity: string;
  position: number;
  /** Sits between blocks and renders as paragraphs, rather than inside a text block. */
  block: boolean;
  /** Followed by punctuation or the end of the line: no gap after the struck text. */
  tight: boolean;
  paragraphs: string[];
  /** The change that removed it. */
  changeId: string;
}

/** One removal before grouping: a single hunk's removed text at its position. */
export interface RemovalInput {
  position: number;
  block: boolean;
  paragraphs: string[];
  tight: boolean;
  changeId: string;
}

/**
 * Merge consecutive block-level removals of one change that land at the same position into
 * one plan, so three deleted paragraphs read "3 paragraphs removed". Inline
 * removals stay one plan each.
 */
export function planRemovals(inputs: readonly RemovalInput[]): RemovalPlan[] {
  const plans: RemovalPlan[] = [];
  for (const input of inputs) {
    const paragraphs = input.paragraphs.filter((paragraph) => paragraph !== "");
    if (paragraphs.join("").trim() === "") continue;
    const last = plans[plans.length - 1];
    if (
      input.block &&
      last?.block &&
      last.position === input.position &&
      last.changeId === input.changeId
    ) {
      last.paragraphs.push(...paragraphs);
      last.identity = removalIdentity(last.changeId, last.paragraphs);
      continue;
    }
    plans.push({
      identity: removalIdentity(input.changeId, paragraphs),
      position: input.position,
      block: input.block,
      tight: input.tight,
      paragraphs,
      changeId: input.changeId,
    });
  }
  return plans;
}

function removalIdentity(changeId: string, paragraphs: readonly string[]): string {
  return JSON.stringify([changeId, paragraphs]);
}

export function removalCharCount(plan: RemovalPlan): number {
  return plan.paragraphs.reduce((total, paragraph) => total + paragraph.length, 0);
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
  const words = plan.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return plural(words, { one: "# word removed", other: "# words removed" });
}

export interface RemovalHandlers {
  /**
   * A click on a removal: its change becomes the focused one, and a click on the
   * fold toggles that removal open or closed. `keyboard` is true when the fold
   * was activated from the keyboard, so focus can follow it to the rebuilt widget.
   */
  activate: (changeId: string, toggleIdentity: string | null, keyboard: boolean) => void;
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
  changeAttr: string;
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
    folded ? REMOVAL_FOLDED_CLASS : "",
    plan.tight && !plan.block ? REMOVAL_TIGHT_CLASS : "",
    options.focused ? "meridian-review-emphasized" : "",
    options.pulsed ? "meridian-review-arrived" : "",
  ]
    .filter(Boolean)
    .join(" ");
  root.setAttribute("contenteditable", "false");
  root.setAttribute(options.changeAttr, plan.changeId);
  if (plan.block) root.setAttribute(REMOVED_BLOCKS_ATTR, String(plan.paragraphs.length));

  if (collapsible) {
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = REMOVAL_TOGGLE_CLASS;
    toggle.setAttribute("aria-expanded", folded ? "false" : "true");
    toggle.textContent = folded ? removalLabel(plan) : t`Hide removed text`;
    root.append(toggle);
    if (options.refocusToggle) queueMicrotask(() => toggle.focus());
  }
  // The text is always here: a fold only hides it.
  for (const text of plan.paragraphs) {
    const del = doc.createElement("del");
    del.className = REMOVAL_TEXT_CLASS;
    del.textContent = text;
    if (plan.block) {
      const paragraph = doc.createElement("p");
      paragraph.append(del);
      root.append(paragraph);
    } else {
      root.append(del);
    }
  }
  // Keep the editor's caret and focus where the writer left them. The change is
  // chosen on click, not on press: choosing rebuilds this widget, and a rebuild
  // between press and release would swallow the click.
  root.addEventListener("mousedown", (event) => event.preventDefault());
  root.addEventListener("click", (event) => {
    const onToggle =
      event.target instanceof Element && event.target.closest(`.${REMOVAL_TOGGLE_CLASS}`);
    // A pointer click on the struck text (not the fold, not Enter on it). The side
    // is read before activating: activating rebuilds this widget, and a detached
    // one has no box to measure.
    const side = !onToggle && event.detail > 0 ? clickedSide(root, event, plan.block) : null;
    options.handlers.activate(plan.changeId, onToggle ? plan.identity : null, event.detail === 0);
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
