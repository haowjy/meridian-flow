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
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";

import { type ContextTab, useContextTabsActions } from "@/client/stores";
import { Button } from "@/components/ui/button";
import type { DocumentSession } from "@/core/editor/document-session";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { cn } from "@/lib/utils";
import { useLiveBindingAcknowledgementHost } from "../dock/editor-review-handoff";
import { usePostApplyHostWake } from "../draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import { useLocalUntitledOwner } from "./account-feature-context";
import { untitledDocumentIsEmpty } from "./untitled-reconciler";
import { useLiveDocumentBinding } from "./use-live-document-binding";

const EditorView = lazy(() =>
  import("@/features/editor/EditorView").then((m) => ({ default: m.EditorView })),
);

const DESKTOP_LOCAL_EDITOR_OWNER = "desktop-context-editor-mount-host";

type EditableContextTab = Extract<ContextTab, { kind: "tracked" | "new" }>;

/** Concurrent-mount cap. The active tab is always counted; the remaining
 *  slots hold the LRU "warm" editors so a switch back stays instant. */
export const MAX_MOUNTED_EDITORS = 6;

export type ContextEditorMountHostProps = {
  projectId: string;
  /** The Work every mounted editor is open in; scopes links and `[[` candidates. */
  workId: string | null;
  /** TRACKED tabs only — viewer tabs are routed elsewhere. */
  trackedTabs: EditableContextTab[];
  /** The currently visible tab id. Must reference a tab in `trackedTabs`. */
  activeTabId: string | null;
  /** Whether the context destination is currently visible. */
  active: boolean;
  onUntitledBecameNonEmpty?: (documentId: string) => void;
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
  workId,
  trackedTabs,
  activeTabId,
  active,
  onUntitledBecameNonEmpty,
}: ContextEditorMountHostProps) {
  const localOwner = useLocalUntitledOwner();
  const { remintNewTab } = useContextTabsActions();
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  // LRU stack of documentIds: head = most recent. Maintained in an effect so
  // we never mutate state during render. The eviction policy reads from this
  // every render to pick which tabs stay mounted.
  const lruRef = useRef<string[]>([]);
  const localSessionsRef = useRef(new Map<string, ReturnType<typeof localOwner.getDetached>>());
  const bindingKeysRef = useRef(new WeakMap<object, string>());
  const [, rerenderAfterRestore] = useState(0);
  const [ownedElsewhere, setOwnedElsewhere] = useState<Set<string>>(() => new Set());
  for (const tab of trackedTabs) {
    if (tab.kind !== "new") continue;
    const key = {
      accountId: localOwner.accountId,
      projectId,
      documentId: tab.documentId,
    };
    const local = localOwner.getDetached(key);
    if (local) localSessionsRef.current.set(tab.documentId, local);
  }
  const knownIds = new Set(trackedTabs.map((tab) => tab.documentId));
  for (const id of localSessionsRef.current.keys()) {
    if (!knownIds.has(id)) localSessionsRef.current.delete(id);
  }

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
  const untitledIds = trackedTabs.filter((tab) => tab.kind === "new").map((tab) => tab.documentId);
  const trackedIdsKey = trackedIds.join("|");
  const untitledIdsKey = untitledIds.join("|");
  useEffect(() => {
    let active = true;
    for (const documentId of untitledIds) {
      if (localSessionsRef.current.has(documentId)) continue;
      void localOwner
        .restore({
          accountId: localOwner.accountId,
          projectId,
          documentId,
        })
        .then((result) => {
          if (!active) return;
          if (result.kind === "opened") {
            if (result.value.key.documentId !== documentId) {
              remintNewTab(projectId, documentId, result.value.key.documentId);
              return;
            }
            localSessionsRef.current.set(documentId, result.value);
            rerenderAfterRestore((value) => value + 1);
            return;
          }
          setOwnedElsewhere((current) => new Set(current).add(documentId));
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [localOwner, projectId, remintNewTab, untitledIdsKey]);
  useEffect(() => {
    const known = new Set(trackedIds);
    lruRef.current = lruRef.current.filter((id) => known.has(id));
  }, [trackedIdsKey]);

  // Local pre-authority sessions still belong to the local owner. Server tabs
  // are retained by their per-tab boundaries below.
  useEffect(() => {
    localOwner.retain(
      DESKTOP_LOCAL_EDITOR_OWNER,
      untitledIds.map((documentId) => ({
        accountId: localOwner.accountId,
        projectId,
        documentId,
      })),
    );
  }, [trackedIdsKey, untitledIdsKey, localOwner, projectId]);

  useEffect(() => {
    return () => {
      localOwner.release(DESKTOP_LOCAL_EDITOR_OWNER);
    };
  }, [localOwner]);

  const mounted = pickMountedIds(lruRef.current, trackedIds, activeTabId, MAX_MOUNTED_EDITORS);

  return (
    <div className="relative min-h-0 flex-1">
      <Suspense fallback={null}>
        {trackedTabs.map((tab) => {
          const isMounted = mounted.has(tab.documentId);
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
          const local = localSessionsRef.current.get(tab.documentId);
          let bindingKey: string | undefined;
          if (local) {
            bindingKey = bindingKeysRef.current.get(local.session);
            if (!bindingKey) {
              bindingKey = `local-editor:${crypto.randomUUID()}`;
              bindingKeysRef.current.set(local.session, bindingKey);
            }
          }
          const renderEditor = (session: DocumentSession | null, failed = false): ReactNode => {
            if (!isMounted) return null;
            return (
              <div
                key={bindingKey ?? tab.documentId}
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
                {ownedElsewhere.has(tab.documentId) ? (
                  <div className="grid h-full place-items-center text-muted-foreground text-sm">
                    <Trans>This document is open in another tab</Trans>
                  </div>
                ) : null}
                {failed ? (
                  <div className="grid h-full place-items-center text-destructive text-sm">
                    <Trans>Couldn't open this document.</Trans>
                  </div>
                ) : null}
                {tab.kind === "new" && local && onUntitledBecameNonEmpty ? (
                  <UntitledInputObserver
                    documentId={tab.documentId}
                    session={local.session}
                    onBecameNonEmpty={onUntitledBecameNonEmpty}
                  />
                ) : null}
                {/* Filename chrome is host-owned: the context tab strip names the
                  active file, so EditorView renders no redundant header bar. */}
                {failed ||
                ownedElsewhere.has(tab.documentId) ||
                (tab.kind === "new" && !local) ||
                !session ? null : waitingForReviewRoom && controller.reviewRoomError ? (
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
                  <>
                    {isActive ? (
                      <ActiveEditorProjection
                        documentId={tab.documentId}
                        session={session}
                        inReview={Boolean(reviewDraftId)}
                        setProjection={setActiveEditorDocumentId}
                      />
                    ) : null}
                    <PresenceSuspension
                      session={session}
                      enabled={Boolean(reviewDraftId && active)}
                    />
                    <EditorView
                      projectId={projectId}
                      workId={workId}
                      documentId={tab.documentId}
                      session={session}
                      bindingKey={bindingKey}
                      // A warm editor is hidden, not gone. Its chrome portals to
                      // the body, where `hidden` on an ancestor means nothing.
                      active={isActive}
                      detached={tab.kind === "new"}
                      schemaType={tab.kind === "tracked" ? tab.schemaType : "document"}
                      reviewDraftId={reviewDraftId}
                      reviewRoomName={reviewRoomName}
                      reviewWorkId={reviewDraftId ? controller.workId : null}
                      onReviewSessionUnavailable={controller.exitInlineReview}
                    />
                  </>
                )}
              </div>
            );
          };
          if (tab.kind === "new") {
            return renderEditor(local?.session ?? null);
          }
          return (
            <ServerTabSessionBoundary
              key={tab.documentId}
              projectId={projectId}
              documentId={tab.documentId}
            >
              {(session, failed) => renderEditor(session, failed)}
            </ServerTabSessionBoundary>
          );
        })}
      </Suspense>
    </div>
  );
}

/** One binding whose lifetime is exactly one actual open server tab. */
export function ServerTabSessionBoundary({
  projectId,
  documentId,
  children,
}: {
  projectId: string;
  documentId: string;
  children: (session: DocumentSession | null, failed: boolean) => ReactNode;
}) {
  const generation = useRef(++serverHostGeneration);
  const binding = useLiveDocumentBinding({
    projectId,
    documentId,
    owner: "desktop-server-tab",
  });
  useLiveBindingAcknowledgementHost(projectId, documentId, binding);
  usePostApplyHostWake(projectId, documentId, generation.current);
  const state = binding.state;
  return children(state.kind === "opened" ? state.session : null, state.kind === "failed");
}

let serverHostGeneration = 0;

function ActiveEditorProjection({
  documentId,
  session,
  inReview,
  setProjection,
}: {
  documentId: string;
  session: DocumentSession;
  inReview: boolean;
  setProjection: (
    documentId: string | null,
    session?: DocumentSession | null,
    inReview?: boolean,
    owner?: object,
  ) => void;
}) {
  const owner = useRef({});
  useEffect(() => {
    setProjection(documentId, session, inReview, owner.current);
    return () => setProjection(null, null, false, owner.current);
  }, [documentId, inReview, session, setProjection]);
  return null;
}

function PresenceSuspension({ session, enabled }: { session: DocumentSession; enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    session.suspendPresence();
    return () => session.resumePresence();
  }, [enabled, session]);
  return null;
}

function UntitledInputObserver({
  documentId,
  session,
  onBecameNonEmpty,
}: {
  documentId: string;
  session: import("@/core/editor/document-session").DocumentSession;
  onBecameNonEmpty: (documentId: string) => void;
}) {
  useEffect(() => {
    const fragment = session.document.getXmlFragment(session.fragmentName);
    let armed = true;
    let observing = true;
    const observe = () => {
      if (!armed || untitledDocumentIsEmpty(fragment)) return;
      onBecameNonEmpty(documentId);
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
  }, [documentId, onBecameNonEmpty, session]);
  return null;
}
