import { keymap } from "@codemirror/view";
import type { ReviewChunk } from "./types";

export interface ChunkNavigationOptions {
  getChunks: () => ReviewChunk[];
  getFocusedChunkIndex: () => number;
  setFocusedChunkIndex: (index: number) => void;
  onAcceptChunk: (chunkId: string) => void;
  onRejectChunk: (chunkId: string) => void;
}

/**
 * Returns a CM6 keymap extension for chunk keyboard navigation.
 *
 * Keybindings:
 *   Ctrl-]        → next chunk
 *   Ctrl-[        → prev chunk
 *   Ctrl-Enter    → accept focused chunk
 *   Ctrl-Backspace → reject focused chunk
 *
 * Note: Mod-] / Mod-[ are intentionally omitted — CodeMirror's default keymap
 * binds Mod-[ and Mod-] for indentation, and the frontend's writer-first
 * philosophy avoids shadowing browser/app navigation shortcuts.
 */
export function chunkNavigationKeymap(opts: ChunkNavigationOptions) {
  return keymap.of([
    {
      key: "Ctrl-]",
      run: () => {
        const chunks = opts.getChunks();
        if (chunks.length === 0) return false;
        const next = Math.min(opts.getFocusedChunkIndex() + 1, chunks.length - 1);
        opts.setFocusedChunkIndex(next);
        return true;
      },
    },
    {
      key: "Ctrl-[",
      run: () => {
        const chunks = opts.getChunks();
        if (chunks.length === 0) return false;
        const prev = Math.max(opts.getFocusedChunkIndex() - 1, 0);
        opts.setFocusedChunkIndex(prev);
        return true;
      },
    },
    {
      key: "Ctrl-Enter",
      run: () => {
        const chunks = opts.getChunks();
        const idx = opts.getFocusedChunkIndex();
        const chunk = chunks[idx];
        if (!chunk) return false;
        opts.onAcceptChunk(chunk.id);
        return true;
      },
    },
    {
      key: "Ctrl-Backspace",
      run: () => {
        const chunks = opts.getChunks();
        const idx = opts.getFocusedChunkIndex();
        const chunk = chunks[idx];
        if (!chunk) return false;
        opts.onRejectChunk(chunk.id);
        return true;
      },
    },
  ]);
}
