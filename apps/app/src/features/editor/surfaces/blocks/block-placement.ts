/**
 * Where the handle and the drop line go, measured on a frame rather than in
 * render.
 *
 * Both readings are `getBoundingClientRect` and `getComputedStyle` against a
 * DOM ProseMirror has only just rewritten, and the surface re-renders on every
 * transaction — the writer's own keystrokes, a peer typing, an AI write
 * landing. Measuring them in render forced a synchronous layout on each one.
 * A frame coalesces the burst, and the state only moves when the numbers did,
 * so a transaction that changed nothing on screen costs one measurement and no
 * render at all.
 *
 * WHICH signals mean "measure again" is not this lane's question. A block
 * travels for reasons a `ResizeObserver` on one element never sees — three
 * paragraphs inserted above, the pane scrolling under a hand that never moved,
 * a diagram finishing its render — and every floating surface in the editor
 * needs the same list, so they share one: `watchManuscriptLayout`.
 *
 * Its own module because it changes for its own reasons: geometry and frame
 * timing, not pointer capture and not what a menu row says.
 */

import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { draggedBlockPos } from "@/core/editor/blocks";
// Straight at the primitive rather than through `chrome/index.ts`: that barrel
// also carries the surface registry this lane is listed in, so the barrel route
// is a module cycle.
import { watchManuscriptLayout } from "@/core/editor/chrome";

import { blockHandlePosition, seamLinePosition } from "./block-geometry";
import { blockAt } from "./block-targets";

export type BlockChromePlacement = {
  handle: ReturnType<typeof blockHandlePosition>;
  line: ReturnType<typeof seamLinePosition>;
};

const NO_BLOCK_CHROME: BlockChromePlacement = { handle: null, line: null };

export function useBlockChromePlacement(
  editor: Editor,
  targetPos: number | null,
  seamIndex: number | null,
): BlockChromePlacement {
  const [placement, setPlacement] = useState<BlockChromePlacement>(NO_BLOCK_CHROME);

  useLayoutEffect(() => {
    const measure = () => {
      if (editor.isDestroyed) return;
      const target = targetPos === null ? null : blockAt(editor.state.doc, targetPos);
      const next: BlockChromePlacement = {
        handle: target ? blockHandlePosition(editor.view, target) : null,
        // No line on the two seams the block already sits between. Dropping
        // there moves nothing, and a jade line promising a landing is the
        // silent rejection law 5 forbids — said in paint rather than in a click.
        line:
          seamIndex === null || restingSeam(editor, seamIndex)
            ? null
            : seamLinePosition(editor.view, seamIndex),
      };
      setPlacement((previous) => (samePlacement(previous, next) ? previous : next));
    };

    // The pointer's own moves are measured at once: the drop line belongs
    // under the pointer on the frame the writer moved it, not the one after.
    // Everything else is a frame late, which is what the shared watcher coalesces to.
    measure();
    return watchManuscriptLayout(editor, [], measure);
  }, [editor, targetPos, seamIndex]);

  return placement;
}

function samePlacement(a: BlockChromePlacement, b: BlockChromePlacement): boolean {
  return (
    a.handle?.top === b.handle?.top &&
    a.handle?.left === b.handle?.left &&
    a.line?.top === b.line?.top &&
    a.line?.left === b.line?.left &&
    a.line?.width === b.line?.width
  );
}

/** True when `seamIndex` is one of the two edges the held block already has. */
function restingSeam(editor: Editor, seamIndex: number): boolean {
  const held = draggedBlockPos(editor.state);
  if (held === null) return false;
  const source = blockAt(editor.state.doc, held);
  return source !== null && (seamIndex === source.index || seamIndex === source.index + 1);
}
