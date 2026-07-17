/**
 * ContextEditorMountHost — hosts the *active* TRACKED context document with
 * a bounded "keep-warm" set of recently-viewed editors.
 *
 * Why this exists. Switching context tabs naively (unmount old, mount new)
 * tears down every `DocumentSession` on every click — losing cursor + scroll
 * state and forcing a full Yjs sync round-trip. We want VS Code / Cursor
 * behaviour: switching tabs is instant and preserves state. So we mount each
 * recently-used tracked editor and hide the inactive ones with `hidden`
 * instead of removing them from the React tree. Document-session transport
 * subscriptions are retained by the registry for the true open-tab set, so a
 * warm-set eviction drops only the view, not the live Yjs session.
 *
 * Bounded set. We cap the warm set at MAX (small) entries. The currently
 * active tab is *always* in the warm set; on eviction we drop the least
 * recently used (other) editor. Its `EditorView` unmounts, but the registry
 * keeps the session alive until the tab actually closes or this host unmounts.
 * That separation preserves document continuity without duplicate
 * transport-level subscriptions when a view remounts.
 *
 * One host owns one slot per documentId — even a `documentId` re-entering
 * the warm set re-uses its same JSX slot keyed by id, so it always passes
 * through React's mount/unmount lifecycle in the natural order:
 *   open A → mount A           [A:active]
 *   open B → mount B           [A:warm, B:active]
 *   open C → mount C           [A:warm, B:warm, C:active]  (if MAX≥3)
 *   open D, evicting A:        unmount A → mount D         [B:warm, C:warm, D:active]
 * React commits the unmount cleanup BEFORE the next render's mount effect for
 * the same `documentId`, so subscribe/unsubscribe stay paired.
 */
import { Trans } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useRef } from "react";

import type { ContextTab } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { pendingReviewDraft } from "@/features/chat/docked-drafts";
import { DraftEntryBanner } from "@/features/editor/DraftEntryBanner";
import { DraftReviewHeader } from "@/features/editor/DraftReviewHeader";
import { EditorBannerSlot } from "@/features/editor/EditorBannerSlot";
import { cn } from "@/lib/utils";
import { TempDocumentSaveBar } from "./TempDocumentSaveBar";
import { untitledDocumentIsEmpty, useUntitledPending } from "./untitled-reconciler";

const EditorView = lazy(() =>
  import("@/features/editor/EditorView").then((m) => ({ default: m.EditorView })),
);

const DESKTOP_CONTEXT_EDITOR_OWNER = "desktop-context-editor-mount-host";

type EditableContextTab = Extract<ContextTab, { kind: "tracked" | "new" }>;

/** Concurrent-mount cap. The active tab is always counted; the remaining
 *  slots hold the LRU "warm" editors so a switch back stays instant. */
export const MAX_MOUNTED_EDITORS = 6;

export type ContextEditorMountHostProps = {
  projectId: string;
  /** TRACKED tabs only — viewer tabs are routed elsewhere. */
  trackedTabs: EditableContextTab[];
  /** The currently visible tab id. Must reference a tab in `trackedTabs`. */
  activeTabId: string | null;
  /** Whether the context destination is currently visible. */
  active: boolean;
  onUntitledBecameNonEmpty?: (documentId: string) => boolean;
  untitledHomeReady?: boolean;
  onUntitledRenamed?: (documentId: string, name: string, path: string) => void;
  onOpenExisting?: (
    scheme: import("@meridian/contracts/protocol").ProjectContextTreeScheme,
    path: string,
  ) => void;
};

/**
 * Picks which subset of TRACKED tab ids should be MOUNTED right now. The
 * caller owns the LRU bookkeeping (a stack of document ids most-recently
 * accessed first). We always include `activeTabId`, then fill with the LRU
 * order until we hit `MAX_MOUNTED_EDITORS`.
 */
export function pickMountedIds(
  lru: readonly string[],
  trackedIds: readonly string[],
  activeTabId: string | null,
  cap: number,
): Set<string> {
  const known = new Set(trackedIds);
  const out = new Set<string>();
  if (activeTabId && known.has(activeTabId)) out.add(activeTabId);
  for (const id of lru) {
    if (out.size >= cap) break;
    if (known.has(id)) out.add(id);
  }
  return out;
}

export function ContextEditorMountHost({
  projectId,
  trackedTabs,
  activeTabId,
  active,
  onUntitledBecameNonEmpty,
  untitledHomeReady = true,
  onUntitledRenamed,
  onOpenExisting,
}: ContextEditorMountHostProps) {
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId, groupForDocument, nowMs } =
    useDraftReview();
  // Track the focused tracked editor even when Context is parked in the dock —
  // lineage chip freshness listens on this id, not on `?screen=context`.
  useEffect(() => {
    setActiveEditorDocumentId(activeTabId);
    return () => setActiveEditorDocumentId(null);
  }, [activeTabId, setActiveEditorDocumentId]);
  // LRU stack of documentIds: head = most recent. Maintained in an effect so
  // we never mutate state during render. The eviction policy reads from this
  // every render to pick which tabs stay mounted.
  const lruRef = useRef<string[]>([]);

  // Bring the active tab to the front of the LRU stack whenever it changes.
  useEffect(() => {
    if (!activeTabId) return;
    const next = [activeTabId, ...lruRef.current.filter((id) => id !== activeTabId)];
    lruRef.current = next;
  }, [activeTabId]);

  // Drop ids for tabs that no longer exist so the LRU stack can't grow
  // unbounded across long sessions. We key the effect on a stringified id
  // list so we re-run when the membership actually changes, not on every
  // parent render (the array identity is fresh each time).
  const trackedIds = trackedTabs.map((t) => t.documentId);
  const trackedIdsKey = trackedIds.join("|");
  useEffect(() => {
    const known = new Set(trackedIds);
    lruRef.current = lruRef.current.filter((id) => known.has(id));
  }, [trackedIdsKey]);

  // Reconcile this desktop host's open-document set with the registry.
  // Sessions outlive view mounts (so leaving Context / warm-set eviction no
  // longer tears down Yjs); they are reclaimed when their document closes
  // (drops out of `trackedTabs`) or when this host unmounts entirely.
  useEffect(() => {
    getDocumentSessionRegistry().retain(DESKTOP_CONTEXT_EDITOR_OWNER, trackedIds);
  }, [trackedIdsKey]);

  useEffect(() => {
    return () => {
      getDocumentSessionRegistry().release(DESKTOP_CONTEXT_EDITOR_OWNER);
    };
  }, []);

  const activeReviewDocumentId =
    active && activeTabId && controller.inlineReview?.documentId === activeTabId
      ? activeTabId
      : null;
  useEffect(() => {
    if (!activeReviewDocumentId) return;
    const session = getDocumentSessionRegistry().get(activeReviewDocumentId);
    session.suspendPresence();
    return () => session.resumePresence();
  }, [activeReviewDocumentId]);

  const mounted = pickMountedIds(lruRef.current, trackedIds, activeTabId, MAX_MOUNTED_EDITORS);

  return (
    <div className="relative min-h-0 flex-1">
      <Suspense fallback={null}>
        {trackedTabs.map((tab) => {
          if (!mounted.has(tab.documentId)) return null;
          const isActive = tab.documentId === activeTabId;
          const selectedReviewDraftId =
            isActive && controller.inlineReview?.documentId === tab.documentId
              ? controller.inlineReview.draftId
              : null;
          const reviewRoomName = selectedReviewDraftId
            ? reviewRoomNameForDraft(tab.documentId, selectedReviewDraftId)
            : null;
          const reviewDraftId = reviewRoomName ? selectedReviewDraftId : null;
          const waitingForReviewRoom = Boolean(selectedReviewDraftId && !reviewRoomName);
          // The not-in-review counterpart to the review header. The same
          // pendingReviewDraft signal drives the dock, so the surfaces never
          // disagree. Only the active tab resolves it; hidden warm-set editors
          // never register draft chrome.
          const pendingGroup =
            tab.kind === "tracked" && active && isActive && !reviewDraftId
              ? groupForDocument(tab.documentId)
              : null;
          const pendingDraft = pendingReviewDraft(pendingGroup, nowMs);
          return (
            <div
              key={tab.documentId}
              data-context-editor-document-id={tab.documentId}
              className={cn(
                // Each editor fills the host's frame; only the active one is
                // visible. `hidden` keeps DOM/state alive without painting.
                "absolute inset-0 flex min-h-0 flex-col",
                isActive ? "" : "hidden",
              )}
              // Defensive: aria-hidden hides background editors from AT.
              aria-hidden={!isActive}
            >
              {tab.kind === "new" && untitledHomeReady && onUntitledBecameNonEmpty ? (
                <UntitledInputObserver
                  documentId={tab.documentId}
                  onBecameNonEmpty={onUntitledBecameNonEmpty}
                />
              ) : null}
              {/* Filename chrome is host-owned: the context tab strip names the
                  active file, so EditorView renders no redundant header bar. */}
              {waitingForReviewRoom && controller.reviewRoomError ? (
                <div className="flex min-h-0 flex-1 items-center justify-center p-6">
                  <div className="surface-card max-w-sm space-y-3 rounded-lg border border-border-subtle p-4 text-center shadow-sm">
                    <p className="font-medium text-foreground text-sm">
                      <Trans>Couldn't open review mode.</Trans>
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <Trans>Try again, or return to the live document.</Trans>
                    </p>
                    <div className="flex justify-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          if (selectedReviewDraftId) {
                            controller.enterInlineReview(tab.documentId, selectedReviewDraftId);
                            return;
                          }
                          controller.exitInlineReview();
                        }}
                      >
                        <Trans>Retry</Trans>
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => controller.exitInlineReview()}
                      >
                        <Trans>Back to live</Trans>
                      </Button>
                    </div>
                  </div>
                </div>
              ) : waitingForReviewRoom ? null : (
                <EditorView
                  projectId={projectId}
                  documentId={tab.documentId}
                  schemaType={tab.kind === "tracked" ? tab.schemaType : "document"}
                  belowToolbar={
                    <EditorBannerSlot
                      tenants={[
                        {
                          name: "draft-chrome",
                          content:
                            isActive && reviewDraftId ? (
                              <DraftReviewHeader
                                documentId={tab.documentId}
                                draftId={reviewDraftId}
                              />
                            ) : pendingGroup && pendingDraft ? (
                              <DraftEntryBanner group={pendingGroup} draft={pendingDraft} />
                            ) : null,
                        },
                        {
                          name: "rename-line",
                          content:
                            isActive &&
                            (tab.kind === "new" ||
                              (tab.kind === "tracked" && tab.provisionalName)) &&
                            onUntitledRenamed &&
                            onOpenExisting ? (
                              <UntitledRenameLine
                                projectId={projectId}
                                tab={tab}
                                onRenamed={onUntitledRenamed}
                                onOpenExisting={onOpenExisting}
                              />
                            ) : null,
                        },
                      ]}
                    />
                  }
                  reviewDraftId={reviewDraftId}
                  reviewRoomName={reviewRoomName}
                  reviewWorkId={reviewDraftId ? controller.workId : null}
                  onReviewSessionUnavailable={controller.exitInlineReview}
                />
              )}
            </div>
          );
        })}
      </Suspense>
    </div>
  );
}

function UntitledRenameLine({
  projectId,
  tab,
  onRenamed,
  onOpenExisting,
}: {
  projectId: string;
  tab: EditableContextTab;
  onRenamed: (documentId: string, name: string, path: string) => void;
  onOpenExisting: NonNullable<ContextEditorMountHostProps["onOpenExisting"]>;
}) {
  const pending = useUntitledPending(tab.documentId);
  return (
    <TempDocumentSaveBar
      projectId={projectId}
      activeThreadId={null}
      tab={tab}
      deviceOnly={pending}
      onRenamed={(name, path) => onRenamed(tab.documentId, name, path)}
      onOpenExisting={onOpenExisting}
    />
  );
}

function UntitledInputObserver({
  documentId,
  onBecameNonEmpty,
}: {
  documentId: string;
  onBecameNonEmpty: (documentId: string) => boolean;
}) {
  useEffect(() => {
    const session = getDocumentSessionRegistry().getDetached(documentId);
    const fragment = session.document.getXmlFragment(session.fragmentName);
    let armed = true;
    let observing = true;
    const observe = () => {
      if (!armed || untitledDocumentIsEmpty(fragment)) return;
      if (!onBecameNonEmpty(documentId)) return;
      armed = false;
      fragment.unobserveDeep(observe);
      observing = false;
    };
    fragment.observeDeep(observe);
    // IndexedDB may already contain words if React remounted this tab.
    void session.whenLocalPersistenceSynced().then(observe);
    return () => {
      armed = false;
      if (observing) fragment.unobserveDeep(observe);
    };
  }, [documentId, onBecameNonEmpty]);
  return null;
}
