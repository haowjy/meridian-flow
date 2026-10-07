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
import type { InlineReviewOperationKind } from "./model";

/** A removal longer than this many characters folds to a one-line label until clicked. */
export const REMOVAL_COLLAPSE_CHARS = 200;

export const REMOVAL_CLASS = "meridian-review-removal";
export const REMOVAL_BLOCK_CLASS = "meridian-review-removal-block";
export const REMOVAL_WRITER_CLASS = "meridian-review-removal-writer";
export const REMOVAL_TOGGLE_CLASS = "meridian-review-removal-toggle";
export const REMOVAL_TEXT_CLASS = "meridian-review-removal-text";

/** One removal widget: the live text one or more adjacent hunks took out at a single position. */
export interface RemovalPlan {
  /** Stable across preview refetches (hunk ids are positional, so they are not used). */
  identity: string;
  position: number;
  /** Sits between blocks and renders as paragraphs, rather than inside a text block. */
  block: boolean;
  kind: InlineReviewOperationKind;
  paragraphs: string[];
  hunkIds: string[];
  operationIds: string[];
}

/** One removal before grouping: a single hunk's deleted text at its resolved position. */
export interface RemovalInput {
  position: number;
  block: boolean;
  kind: InlineReviewOperationKind;
  text: string;
  hunkId: string;
  operationIds: string[];
}

/**
 * Merge consecutive block-level removals that land at the same position into
 * one plan, so three deleted paragraphs read "3 paragraphs removed". Inline
 * removals stay one plan each. The group is the writer's removal only when
 * every member is.
 */
export function planRemovals(inputs: readonly RemovalInput[]): RemovalPlan[] {
  const plans: RemovalPlan[] = [];
  for (const input of inputs) {
    const text = input.text.trim() === "" ? null : input.text;
    if (text === null) continue;
    const last = plans[plans.length - 1];
    if (input.block && last?.block && last.position === input.position) {
      last.paragraphs.push(text);
      last.hunkIds.push(input.hunkId);
      for (const id of input.operationIds) {
        if (!last.operationIds.includes(id)) last.operationIds.push(id);
      }
      if (input.kind === "agent") last.kind = "agent";
      last.identity = removalIdentity(last.operationIds, last.paragraphs);
      continue;
    }
    plans.push({
      identity: removalIdentity(input.operationIds, [text]),
      position: input.position,
      block: input.block,
      kind: input.kind,
      paragraphs: [text],
      hunkIds: [input.hunkId],
      operationIds: [...input.operationIds],
    });
  }
  return plans;
}

function removalIdentity(operationIds: readonly string[], paragraphs: readonly string[]): string {
  const chars = paragraphs.reduce((total, text) => total + text.length, 0);
  return `${operationIds.join("+")}:${paragraphs.length}:${chars}:${paragraphs[0]?.slice(0, 24) ?? ""}`;
}

export function removalCharCount(plan: RemovalPlan): number {
  return plan.paragraphs.reduce((total, text) => total + text.length, 0);
}

export function isCollapsible(plan: RemovalPlan): boolean {
  return removalCharCount(plan) > REMOVAL_COLLAPSE_CHARS;
}

/** "1 paragraph removed", "3 paragraphs removed", or "42 words removed" for a long span inside one. */
export function removalLabel(plan: RemovalPlan): string {
  if (plan.block) {
    const count = plan.paragraphs.length;
    return `${count} ${count === 1 ? "paragraph" : "paragraphs"} removed`;
  }
  const words = plan.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return `${words} ${words === 1 ? "word" : "words"} removed`;
}

export interface RemovalHandlers {
  /** Adopt this removal's change as the focused one. */
  focus: (operationId: string) => void;
  toggle: (identity: string) => void;
}

export interface RemovalRenderOptions {
  focused: boolean;
  expanded: boolean;
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
  const root = doc.createElement(plan.block ? "div" : "span");
  root.className = [
    REMOVAL_CLASS,
    plan.block ? REMOVAL_BLOCK_CLASS : "",
    plan.kind === "writer" ? REMOVAL_WRITER_CLASS : "",
    options.focused ? "meridian-review-emphasized" : "",
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
    toggle.textContent = folded ? removalLabel(plan) : "Hide removed text";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      options.handlers.toggle(plan.identity);
    });
    root.append(toggle);
  }
  if (!folded) {
    for (const text of plan.paragraphs) {
      const struck = doc.createElement("del");
      struck.className = REMOVAL_TEXT_CLASS;
      struck.textContent = text;
      if (plan.block) {
        const paragraph = doc.createElement("p");
        paragraph.append(struck);
        root.append(paragraph);
      } else {
        root.append(struck);
      }
    }
  }
  // Keep the editor's caret and focus where the writer left them; the click
  // only chooses which change is selected.
  root.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const [operationId] = plan.operationIds;
    if (operationId) options.handlers.focus(operationId);
  });
  return root;
}
