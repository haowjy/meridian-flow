/**
 * useInlineReviewSync — pushes the server hunk model into the draft editor and
 * asks for a refresh when the draft or live manuscript changes.
 *
 * This hook is the seam between the review query (`useDraftPreview`) and the
 * `DraftInlineReviewExtension` plugin: the extension is a passive receiver
 * of models delivered via command. The hook is the ONLY writer.
 *
 *   preview has operations+hunks          ← push InlineReviewModel into the plugin
 *   preview panel without a model         ← caller exits inline review and opens the panel
 *   draft/live doc update                 ← debounce, then refetch the preview
 *
 * The refetch → new model → command dispatch loop is what lets the writer see
 * their edits recolor as "You" hunks: server recomputes hunks against the
 * live draft, client just receives them.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useRef } from "react";
import { useDraftPreview } from "@/client/query/useDraftPreview";
import type { DocumentSession } from "@/core/editor/document-session";
import { buildInlineReviewModel } from "@/core/editor/extensions/inline-review";

const DEFAULT_DEBOUNCE_MS = 500;

export interface UseInlineReviewSyncOptions {
  /** The mounted editor bound to the draft room. Null when not in review. */
  editor: Editor | null;
  /** Already-retained live manuscript session; used only to observe collaborator edits. */
  liveSession: DocumentSession | null;
  /** Work + draft identity — same tuple `useDraftPreview` needs. */
  projectId: string | null;
  workId: string | null;
  documentId: string | null;
  draftId: string | null;
  /** When true, actually connect the extension. Callers pass true when
   *  `reviewDraftId` is set on the editor view. */
  enabled: boolean;
  /** Milliseconds to wait after a local edit before refetching hunks. */
  debounceMs?: number;
  /** Called when the active inline session cannot produce an inline model. */
  onHardFallback?: () => void;
}

export interface InlineReviewSyncState {
  /** True once the server has responded with a usable inline model. */
  hasInlineModel: boolean;
  /** Server recommendation for the latest preview; soft panel can still carry an inline model. */
  recommendedSurface: "inline" | "panel" | null;
  /** Human-facing reason for a panel fallback (e.g. `"rewrite_threshold"`). */
  fallbackReason: string | null;
  isFetching: boolean;
  isError: boolean;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): InlineReviewSyncState {
  const { editor, liveSession, projectId, workId, documentId, draftId, enabled, onHardFallback } =
    options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const { preview, isFetching, isError, refetch } = useDraftPreview(
    projectId,
    workId,
    documentId,
    draftId,
    {
      enabled: enabled && Boolean(projectId && workId && documentId && draftId),
      surface: "inline",
    },
  );

  // Track the last model payload we pushed so we don't re-dispatch the same
  // command when React re-renders around unrelated state.
  const lastPushedIdentityRef = useRef<string | null>(null);
  const hardFallbackIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!editor || editor.isDestroyed || !enabled) return;
    // The extension is only mounted when review mode is active — outside of
    // review the command surface is absent, so calling it would throw.
    if (!("setInlineReviewModel" in editor.commands)) return;

    const hasModel = preview?.status === "active" && preview.inlineModelPresent;

    if (!hasModel) {
      if (lastPushedIdentityRef.current != null) {
        editor.commands.setInlineReviewModel(null);
        lastPushedIdentityRef.current = null;
      }
      if (preview?.status === "active" && !preview.inlineModelPresent) {
        const fallbackIdentity = `${preview.draftId}:${preview.liveRevisionToken}:${preview.draftRevisionToken}`;
        if (hardFallbackIdentityRef.current !== fallbackIdentity) {
          hardFallbackIdentityRef.current = fallbackIdentity;
          onHardFallback?.();
        }
      }
      return;
    }

    const operations = preview.operations;
    const hunks = preview.hunks;
    if (!operations || !hunks) return;

    const identity = `${preview.draftId}:${preview.liveRevisionToken}:${preview.draftRevisionToken}`;
    if (lastPushedIdentityRef.current === identity) return;

    const model = buildInlineReviewModel({
      liveRevisionToken: preview.liveRevisionToken,
      draftRevisionToken: preview.draftRevisionToken,
      operations,
      hunks,
    });
    editor.commands.setInlineReviewModel(model);
    lastPushedIdentityRef.current = identity;
    hardFallbackIdentityRef.current = null;
  }, [editor, enabled, preview, onHardFallback]);

  // Debounced refetch on draft edits and live manuscript changes. The live
  // session is the already-retained document session, so this observes the
  // existing Y.Doc instead of creating a second collaboration connection.
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
    liveSession?.document.on("update", schedule);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off("update", schedule);
      liveSession?.document.off("update", schedule);
    };
  }, [editor, liveSession, enabled, refetch, debounceMs]);

  return {
    hasInlineModel:
      preview?.status === "active" && preview.inlineModelPresent && preview.hunks.length > 0,
    recommendedSurface: preview?.status === "active" ? preview.recommendedSurface : null,
    fallbackReason:
      preview?.status === "active" && preview.recommendedSurface === "panel"
        ? (preview.fallbackReason ?? null)
        : null,
    isFetching,
    isError,
  };
}
