/**
 * useInlineReviewSync — pushes the server hunk model into the draft editor and
 * reports model availability while draft or live manuscript changes trigger refreshes.
 *
 * This hook is the seam between the review query (`useDraftPreview`) and the
 * `DraftInlineReviewExtension` plugin: the extension is a passive receiver
 * of models delivered via command. The hook is the ONLY writer.
 *
 *   preview has operations+hunks          ← push InlineReviewModel into the plugin
 *   preview panel without a model         ← report to the review session owner
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
  /** Reports that the active inline session cannot produce an inline model. */
  onInlineModelUnavailable?: (identity: string) => void;
  /** Reports the pushed model identity so the session can clear fallback dedupe state. */
  onInlineModelAvailable?: (identity: string) => void;
}

export function useInlineReviewSync(options: UseInlineReviewSyncOptions): void {
  const {
    editor,
    liveSession,
    projectId,
    workId,
    documentId,
    draftId,
    enabled,
    onInlineModelUnavailable,
    onInlineModelAvailable,
  } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const { preview, refetch } = useDraftPreview(projectId, workId, documentId, draftId, {
    enabled: enabled && Boolean(projectId && workId && documentId && draftId),
  });

  // Track the last model payload we pushed so we don't re-dispatch the same
  // command when React re-renders around unrelated state.
  const lastPushedIdentityRef = useRef<string | null>(null);

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
        onInlineModelUnavailable?.(
          `${preview.draftId}:${preview.liveRevisionToken}:${preview.draftRevisionToken}`,
        );
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
    onInlineModelAvailable?.(identity);
  }, [editor, enabled, preview, onInlineModelUnavailable, onInlineModelAvailable]);

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
}
