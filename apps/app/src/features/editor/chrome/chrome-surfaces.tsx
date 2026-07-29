/**
 * The chrome surface registration list — the append-only seam that keeps six
 * lanes out of `EditorView.tsx`.
 *
 * One entry per surface. `EditorChromeHost` renders them all; nothing else
 * mounts editor chrome, and no lane edits the host. A rebase between lanes is
 * then two lines landing beside each other rather than on top of each other.
 *
 * `.tsx` on purpose: a lane writes its entry as JSX right here, and renaming a
 * shared file is a collision every other lane would feel.
 *
 * A surface gets the editor and nothing else. Everything it needs about the
 * writer's current state — the deepest context, suppression, the Esc chain —
 * it reads from the kernel through `useEditorChrome`, so the host has no
 * growing prop list and a lane never has to ask for one.
 */

import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { BLOCK_MOVEMENT_SURFACE_ID, BlockMovementSurface } from "../surfaces/blocks";
import { SlashMenu } from "../surfaces/slash";

export type EditorChromeSurfaceProps = {
  editor: Editor;
};

export type EditorChromeSurface = {
  /** Stable; also the React key and what a probe looks for. */
  id: string;
  render: (props: EditorChromeSurfaceProps) => ReactNode;
};

export const EDITOR_CHROME_SURFACES: readonly EditorChromeSurface[] = [
  // L-A formatting menu (M4)
  // L-B object controls + diagram (M5)
  // L-C table chrome (M6)
  { id: "slash-menu", render: (props) => <SlashMenu {...props} /> }, // L-D slash (M8)
  // L-E block movement (M9)
  {
    id: BLOCK_MOVEMENT_SURFACE_ID,
    render: ({ editor }) => <BlockMovementSurface editor={editor} />,
  },
  // L-F links (M7)
];
