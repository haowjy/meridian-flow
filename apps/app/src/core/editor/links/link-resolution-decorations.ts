/**
 * Drawing what the resolver answered, without storing any of it.
 *
 * The state rides a decoration rather than a schema attribute, which is the
 * whole point of law 9: the mark stores what a link names (its ref and href),
 * and nothing about whether it resolves ever reaches the wire or another
 * peer's document. A decoration is also the only shape that can change
 * without a write, and this one changes as soon as an answer lands.
 *
 * Gone and missing both draw dashed, and the span says which in words for a
 * screen reader: a gone link is no longer available, a missing one does not
 * exist yet.
 *
 * ProseMirror puts an inline decoration's attributes on a span INSIDE the link
 * mark's `<a>`, one span per text node, so a label with bold in it carries
 * several. The `<a>` is one element around the whole label (the link mark
 * renders outermost), and the link chip stylesheet
 * (`components/app/link-chip/link-chip.css`) draws the chip on it through
 * `:has()`. That is a fact about how marks and decorations nest, not a choice.
 */

import { t } from "@lingui/core/macro";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AddMarkStep, RemoveMarkStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { isRemoteDocumentRebuild } from "../anchors";
import { linkChip, linkChipPartAttributes } from "./link-chip";
import type { LinkKey, LinkResolution, LinkResolutionEntry } from "./link-resolution";
import { classifyLinkTarget, isInternalLinkTarget, linkTargetHref } from "./link-target";

const linkResolutionPluginKey = new PluginKey<LinkResolutionPluginState>("linkResolution");

type LinkResolutionPluginState = {
  decorations: DecorationSet;
  /** Every internal link in the document, once per ref and canonical href. */
  links: readonly LinkKey[];
};

/** Meta that says "an answer landed", the one reason to redraw without an edit. */
const ANSWERED = "answered";

const EMPTY: LinkResolutionPluginState = {
  decorations: DecorationSet.empty,
  links: [],
};

export function linkResolutionPlugin(resolution: LinkResolution): Plugin {
  return new Plugin<LinkResolutionPluginState>({
    key: linkResolutionPluginKey,

    state: {
      init: (_config, state) => read(state.doc, resolution),
      /**
       * A scan of the whole document per keystroke is what this avoids, and
       * the three cases are not interchangeable:
       *
       * - An answer landed: nothing moved, but what to draw changed. Rebuild.
       * - A peer's write: y-prosemirror replaces the WHOLE document in one
       *   step, so `map` reports every position deleted and would drop every
       *   decoration on the page (see `core/editor/anchors.ts`). Rebuild.
       * - A local edit that reaches a link, by mark or by text: the ranges
       *   themselves changed. Rebuild.
       *
       * Everything else is prose moving past decorations that still describe
       * the same links, and mapping carries them for the cost of the edit
       * rather than the cost of the document.
       */
      apply(transaction, value, old, state) {
        if (transaction.getMeta(linkResolutionPluginKey)) return read(state.doc, resolution);
        if (!transaction.docChanged) return value;
        if (
          isRemoteDocumentRebuild(transaction) ||
          reachesLink(transaction, old.schema.marks.link)
        ) {
          return read(state.doc, resolution);
        }
        return {
          decorations: value.decorations.map(transaction.mapping, transaction.doc),
          links: value.links,
        };
      },
    },

    props: {
      decorations: (state) => linkResolutionPluginKey.getState(state)?.decorations,
    },

    /**
     * The effectful half. Asking is a side effect and belongs nowhere near
     * `apply`, so the view asks about whatever the last scan found and redraws
     * when an answer arrives. The loop terminates because a link with an
     * answer is never asked about again.
     */
    view(view) {
      let scheduled = false;
      // Deferred, and coalesced with it: an answer can land while this same
      // view is asking the question, and a transaction dispatched from inside
      // a view update is the one ProseMirror refuses to apply.
      const redraw = () => {
        if (scheduled || view.isDestroyed) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (view.isDestroyed) return;
          view.dispatch(view.state.tr.setMeta(linkResolutionPluginKey, ANSWERED));
        });
      };
      const unsubscribe = resolution.subscribe(redraw);
      const ask = () => {
        const state = linkResolutionPluginKey.getState(view.state);
        if (state) resolution.request(state.links);
      };
      ask();

      return {
        update: ask,
        destroy: unsubscribe,
      };
    },
  });
}

/**
 * True when anything this transaction changed involved a link — the mark
 * going on or coming off, or text inside one moving.
 *
 * A mark step carries no position change at all, so it is asked about
 * directly; every other step is judged by what its own changed ranges held
 * before and hold after.
 */
function reachesLink(transaction: Transaction, linkType: MarkType | undefined): boolean {
  // A code file's schema has no link mark, and nothing here can be drawn on it.
  if (!linkType) return false;

  return transaction.steps.some((step, index) => {
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      return step.mark.type === linkType;
    }

    const before = transaction.docs[index];
    const after = transaction.docs[index + 1] ?? transaction.doc;
    let reached = false;
    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      reached ||=
        linkAround(before, linkType, oldStart, oldEnd) ||
        linkAround(after, linkType, newStart, newEnd);
    });
    return reached;
  });
}

/**
 * Widened by one position on each side. Typing at either edge of a link lands
 * inside the range the writer sees as the link, and a changed range that only
 * touches a boundary holds no mark of its own to report.
 */
function linkAround(doc: PMNode, linkType: MarkType, from: number, to: number): boolean {
  return doc.rangeHasMark(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), linkType);
}

function read(doc: PMNode, resolution: LinkResolution): LinkResolutionPluginState {
  // Nothing to draw and nothing to ask: an editor with no project behind it
  // pays for no scan.
  if (!resolution.available) return EMPTY;

  const decorations: Decoration[] = [];
  const links = new Map<string, LinkKey>();

  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (!mark) return false;
    const target = classifyLinkTarget(String(mark.attrs.href ?? ""));
    if (!target || !isInternalLinkTarget(target)) return false;

    const link: LinkKey = {
      ref: typeof mark.attrs.ref === "string" ? mark.attrs.ref : null,
      href: linkTargetHref(target),
    };
    links.set(`${link.ref ?? ""}\u0000${link.href}`, link);
    const entry = resolution.read(link);
    // Every internal link is drawn, answered or not: a failed or unasked one
    // is a filled chip in its own family, never a missing one.
    const chip = linkChip(target, entry, resolution.baseUri);
    const description = linkStateDescription(entry);
    decorations.push(
      Decoration.inline(pos, pos + node.nodeSize, {
        ...(entry ? { "data-link-state": entry.state } : {}),
        ...(description ? { "aria-description": description } : {}),
        ...(chip ? linkChipPartAttributes(chip) : {}),
      }),
    );
    return false;
  });

  return { decorations: DecorationSet.create(doc, decorations), links: [...links.values()] };
}

/** What a dashed link says to a screen reader, in the hint's own words. */
export function linkStateDescription(entry: LinkResolutionEntry | null): string | null {
  if (entry?.state === "gone") return t`No longer available`;
  if (entry?.state === "unresolved") return t`Doesn't exist yet`;
  return null;
}
