/**
 * useInlineReviewSync — pushes the server hunk model into the draft editor and
 * asks for a refresh when the writer edits.
 *
 * This hook is the seam between the review query (`useDraftPreview`) and the
 * `DraftInlineReviewExtension` plugin: the extension is a passive receiver
 * of models delivered via command. The hook is the ONLY writer.
 *
 *   preview.reviewMode === "inline"      ← push InlineReviewModel into the plugin
 *   preview.reviewMode === "panel"       ← clear the plugin; the caller falls back to DraftDiffPanel
 *   local editor update                   ← debounce, then refetch the preview
 *
 * The refetch → new model → command dispatch loop is what lets the writer see
 * their edits recolor as "You" hunks: server recomputes hunks against the
 * live draft, client just receives them.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useRef } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";

const DEFAULT_DEBOUNCE_MS = 500;

export interface UseInlineReviewSyncOptions {
  /** The mounted editor bound to the draft room. Null when not in review. */
  editor: Editor | null;
  /** Thread + draft identity — same tuple `useDraftPreview` needs. */
  threadId: string | null;
  documentId: string | null;
  draftId: string | null;
  /** When true, actually connect the extension. Callers pass true when
   *  `reviewDraftId` is set on the editor view. */
  enabled: boolean;
  /** Milliseconds to wait after a local edit before refetching hunks. */
  debounceMs?: number;
}

export interface InlineReviewSyncState {
  /** True once the server has responded with a usable inline model. */
  hasInlineModel: boolean;
  /** `"panel"` when the server decided this diff is too big for inline. */
  reviewMode: "inline" | "panel" | null;
  /** Human-facing reason for a panel fallback (e.g. `"rewrite_threshold"`). */
  fallbackReason: string | null;
  isFetching: boolean;
  isError: boolean;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): InlineReviewSyncState {
  const { editor, threadId, documentId, draftId, enabled } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const { preview, isFetching, isError, refetch } = useDraftPreview(threadId, documentId, draftId, {
    enabled: enabled && Boolean(threadId && documentId && draftId),
  });

  // Track the last model payload we pushed so we don't re-dispatch the same
  // command when React re-renders around unrelated state.
  const lastPushedRevisionRef = useRef<number | null>(null);
  const lastPushedDraftIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !enabled) return;
    // The extension is only mounted when review mode is active — outside of
    // review the command surface is absent, so calling it would throw.
    if (!("setInlineReviewModel" in editor.commands)) return;

    if (preview?.status !== "active" || preview.reviewMode !== "inline") {
      // Clear any stale model so a mode flip (inline → panel) doesn't leave
      // decorations painted from the previous session.
      if (lastPushedRevisionRef.current != null) {
        editor.commands.setInlineReviewModel(null);
        lastPushedRevisionRef.current = null;
        lastPushedDraftIdRef.current = null;
      }
      return;
    }

    const revision = preview.draftRevisionToken;
    if (
      lastPushedDraftIdRef.current === preview.draftId &&
      lastPushedRevisionRef.current === revision
    ) {
      return;
    }

    const model = buildInlineReviewModel({
      draftRevisionToken: revision,
      operations: preview.operations ?? [],
      hunks: preview.hunks ?? [],
    });
    editor.commands.setInlineReviewModel(model);
    lastPushedRevisionRef.current = revision;
    lastPushedDraftIdRef.current = preview.draftId;
  }, [editor, enabled, preview]);

  // Debounced refetch on writer edits. Editor 'update' fires for both local
  // and remote transactions, but calling refetch under staleTime is cheap
  // because TanStack Query dedupes and the query key is stable.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refetch();
      }, debounceMs);
    };
    editor.on("update", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", schedule);
    };
  }, [editor, enabled, refetch, debounceMs]);

  return {
    hasInlineModel:
      preview?.status === "active" &&
      preview.reviewMode === "inline" &&
      (preview.hunks?.length ?? 0) > 0,
    reviewMode: preview?.status === "active" ? preview.reviewMode : null,
    fallbackReason:
      preview?.status === "active" && preview.reviewMode === "panel"
        ? (preview.fallbackReason ?? null)
        : null,
    isFetching,
    isError,
  };
}
