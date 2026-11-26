import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { draggedBlockPos } from "@/core/editor/blocks";
// Straight at the primitive rather than through `chrome/index.ts`: that barrel
// also carries the surface registry this lane is listed in, so the barrel route
// is a module cycle.
import { watchManuscriptLayout } from "@/core/editor/chrome";
import { manuscriptOverlay } from "@/features/editor/chrome/manuscript-overlay";

import { blockHandlePosition, seamLinePosition } from "./block-geometry";
import { blockAt, blockRun } from "./block-targets";

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
      const overlay = manuscriptOverlay(editor);
      const target = targetPos === null || !overlay ? null : blockAt(editor.state.doc, targetPos);
      const next: BlockChromePlacement = {
        handle: target && overlay ? blockHandlePosition(editor.view, overlay, target) : null,
        // No line on the two seams the block already sits between. Dropping
        // there moves nothing, and a jade line promising a landing is the
        // silent rejection law 5 forbids — said in paint rather than in a click.
        line:
          seamIndex === null || !overlay || restingSeam(editor, seamIndex)
            ? null
            : seamLinePosition(editor.view, overlay, seamIndex),
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

function restingSeam(editor: Editor, seamIndex: number): boolean {
  const held = draggedBlockPos(editor.state);
  if (held === null) return false;
  const source = blockAt(editor.state.doc, held);
  if (source === null) return false;
  const run = blockRun(editor.state.doc, source);
  return seamIndex >= run.index && seamIndex <= run.endIndex;
}
