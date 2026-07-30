/**
 * Whether a picture stands IN a line of prose, or holds the column.
 *
 * The schema has always allowed `text ![alt](src) text` inside one paragraph,
 * and a drag between two words already lands the node exactly there. What the
 * writer saw was still not inline: a picture rendered at the prose column's full
 * width fills the whole line box, so the words before it and after it wrap onto
 * lines of their own and nothing flows beside it. Inline in the document, block
 * on the page (human ruling, 2026-07-30: "inline should literally mean inline").
 *
 * So a picture that SHARES its text block with anything else is capped on its
 * long edge, and one that has its block to itself keeps the column. That is the
 * whole rule, and it is read off the document rather than stored: a peer with
 * the same paragraph draws the same picture, and typing a word beside a picture
 * (or deleting the last one) moves it between the two readings by itself.
 *
 * Told twice on purpose, because two different things have to act on it: the
 * class, so the line box can align the picture with the words beside it, and the
 * decoration's spec, so the node view can cap the frame it reserves for a
 * picture still uploading (`ImageNodeView`). Neither is a node attribute — the
 * fact is derivable, and an attribute would put it in Yjs, on the wire, and in
 * every peer's undo history.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** Marks a picture standing in a line of prose. Read by `editor.css`. */
export const IMAGE_IN_LINE_CLASS = "meridian-image-in-line";

/**
 * The longest edge a picture in a line of prose may have, in pixels.
 *
 * A line has to keep holding words on both sides of it, so the picture is a
 * picture-sized word rather than a column-wide plate. `editor.css` caps the
 * pictures it can reach with the same number written as `15rem`; this one is for
 * the frame an upload reserves, which is a measurement and has to be arithmetic.
 */
export const IN_LINE_MAX_EDGE = 240;

/** Scales a measured shape down until neither edge passes the cap. */
export function inLineScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  return longest > IN_LINE_MAX_EDGE ? IN_LINE_MAX_EDGE / longest : 1;
}

/**
 * Every picture in the document that shares its text block with other content.
 *
 * Block containers are descended into; inline content never is. A textblock
 * holding one child holds only the picture, and that is the column-wide reading.
 */
export function imagesInLine(doc: PMNode): Decoration[] {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.childCount < 2) return false;
    let at = pos + 1;
    node.forEach((child) => {
      if (child.type.name === "image") {
        decorations.push(
          Decoration.node(at, at + child.nodeSize, { class: IMAGE_IN_LINE_CLASS }, IN_LINE_SPEC),
        );
      }
      at += child.nodeSize;
    });
    return false;
  });

  return decorations;
}

/** Is the picture this node view renders standing in a line of prose? */
export function imageStandsInLine(decorations: readonly { spec?: unknown }[]): boolean {
  return decorations.some(
    (decoration) =>
      (decoration.spec as { imageInLine?: boolean } | undefined)?.imageInLine === true,
  );
}

export function imageLinePlacementPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const decorations = imagesInLine(state.doc);
        return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : null;
      },
    },
  });
}

const IN_LINE_SPEC = { imageInLine: true } as const;
