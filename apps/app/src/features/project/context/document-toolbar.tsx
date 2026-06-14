// @ts-nocheck
/**
 * document-toolbar — single source of truth for the Context destination's
 * per-document-type toolbar taxonomy.
 *
 * Purpose: the toolbar under the tab strip differs by the active document's
 * type — markdown-like editable docs get the formatting bar (H1 B I …); binary
 * viewer tabs (image/pdf) and the empty "select a document" placeholder get a
 * minimal bar that only carries the "show files" reopen affordance when files
 * is collapsed.
 *
 * Key decisions:
 *  - The taxonomy lives in the CONTEXT layer (not `features/editor`, which
 *    stays generic — it only consumes a plain `leading` ReactNode slot).
 *    Adding `"code"` / `"csv"` / etc. later is a one-line change to
 *    `DocumentToolbarVariant` + `documentToolbarVariant()`.
 *  - `FilesToggle` is REOPEN-ONLY. Collapse lives on the files panel's own
 *    header (mirrors the left sidebar's "click without moving the cursor"
 *    pattern). The reopen button appears whenever files is collapsed in
 *    every variant — that's the invariant that keeps files always
 *    re-openable from the body's top-left.
 */
import { t } from "@lingui/core/macro";
import { PanelLeftOpen } from "lucide-react";

import type { ContextTab } from "@/client/stores";

import { PanelToggleButton } from "../shell/PanelToggleButton";

/**
 * Toolbar variant dispatched from the active context tab. Extend by adding
 * new literals here and a branch in `documentToolbarVariant`.
 */
export type DocumentToolbarVariant = "markdown" | "viewer" | "empty";

/**
 * Map an active context tab to the toolbar variant it should render.
 * `null` (no active tab) → the empty variant.
 */
export function documentToolbarVariant(tab: ContextTab | null): DocumentToolbarVariant {
  if (!tab) return "empty";
  if (tab.editable) {
    // Today: every editable tab is markdown-like (TipTap/ProseMirror doc).
    // If we ever land a non-markdown editable schema (e.g. structured form),
    // narrow on `tab.filetype` / `tab.schemaType` here.
    return "markdown";
  }
  // Non-editable (image / pdf / generic binary) → viewer toolbar.
  return "viewer";
}

export type FilesToggleProps = {
  /** Whether the files panel is currently open. */
  open: boolean;
  /** Reopen the files panel. */
  onExpand: () => void;
};

/**
 * Reopen-only files control rendered inside the per-variant toolbar.
 *
 *   files COLLAPSED → "Show files" reopen button (every variant — INVARIANT).
 *   files OPEN      → null (collapse lives on the files panel's own header).
 */
export function FilesToggle({ open, onExpand }: FilesToggleProps) {
  if (open) return null;
  return <PanelToggleButton icon={PanelLeftOpen} label={t`Show files`} onClick={onExpand} />;
}
