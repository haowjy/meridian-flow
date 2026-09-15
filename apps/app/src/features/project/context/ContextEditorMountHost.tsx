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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";
import type { DocumentSession } from "@/core/editor/document-session";
import type { ResourceContentHandle } from "@/core/resources/resource-content-access";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { EditorView } from "@/features/editor/EditorView";
import { cn } from "@/lib/utils";
import { useLiveBindingAcknowledgementHost } from "../dock/editor-review-handoff";
import { usePostApplyHostWake } from "../draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import { useAccountResourceReplica } from "./account-feature-context";
import { resourceDocumentIsEmpty } from "./resource-document-eligibility";
import { useLiveDocumentBinding } from "./use-live-document-binding";

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
  readOnly?: boolean;
  onUntitledBecameNonEmpty?: (documentId: string) => Promise<void>;
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
  readOnly = false,
}: ContextEditorMountHostProps) {
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  // LRU stack of documentIds: head = most recent. Maintained in an effect so
  // we never mutate state during render. The eviction policy reads from this
  // every render to pick which tabs stay mounted.
  const lruRef = useRef<string[]>([]);
  const bindingKeysRef = useRef(new WeakMap<object, string>());

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

  const mounted = pickMountedIds(lruRef.current, trackedIds, activeTabId, MAX_MOUNTED_EDITORS);

  return (
    <div className="relative min-h-0 flex-1">
      {trackedTabs.map((tab) => {
        const resourceHandle = tab.resourceHandle;
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
        const renderEditor = (
          session: DocumentSession | null,
          failed = false,
          localContentReady = false,
        ): ReactNode => {
          if (!isMounted) return null;
          let bindingKey: string | undefined;
          if (session) {
            bindingKey = bindingKeysRef.current.get(session);
            if (!bindingKey) {
              bindingKey = `resource-editor:${crypto.randomUUID()}`;
              bindingKeysRef.current.set(session, bindingKey);
            }
          }
          return (
            <div
              data-context-editor-document-id={tab.documentId}
              className={cn(
                // Each editor fills the host's frame; only the active one is
                // visible. `hidden` keeps DOM/state alive without painting.
                "absolute inset-0 flex min-h-0 flex-col",
                isActive ? "" : "hidden",
              )}
              // Defensive: aria-hidden hides background editors from AT.
              aria-hidden={!isActive}
              aria-busy={!failed && !session}
            >
              {failed ? (
                <div className="grid h-full place-items-center text-destructive text-sm">
                  <Trans>Couldn't open this document.</Trans>
                </div>
              ) : null}
              {!failed && !session ? <DelayedContentSkeleton className="absolute inset-0" /> : null}
              {tab.kind === "new" && session && onUntitledBecameNonEmpty ? (
                <UntitledInputObserver
                  documentId={tab.documentId}
                  session={session}
                  onBecameNonEmpty={onUntitledBecameNonEmpty}
                />
              ) : null}
              {/* Filename chrome is host-owned: the context tab strip names the
                  active file, so EditorView renders no redundant header bar. */}
              {failed || !session ? null : waitingForReviewRoom && controller.reviewRoomError ? (
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
                  {active && isActive ? (
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
                    active={active && isActive}
                    editable={!readOnly}
                    showToolbar={!readOnly}
                    showCollaborationDecorations={!readOnly}
                    detached={tab.kind === "new"}
                    localContentReady={localContentReady}
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
        return (
          <ContextTabSessionBoundary
            key={tab.tabInstanceId ?? tab.documentId}
            projectId={projectId}
            documentId={tab.documentId}
            resourceHandle={resourceHandle}
            active={active && isActive}
          >
            {renderEditor}
          </ContextTabSessionBoundary>
        );
      })}
    </div>
  );
}

/** One stable host across local adoption; server retention lasts until the tab closes. */
export function ContextTabSessionBoundary({
  projectId,
  documentId,
  resourceHandle,
  children,
  active = true,
}: {
  projectId: string;
  documentId: string;
  resourceHandle?: string;
  active?: boolean;
  children: (
    session: DocumentSession | null,
    failed: boolean,
    localContentReady: boolean,
  ) => ReactNode;
}) {
  const resources = useAccountResourceReplica();
  const generation = useRef(++serverHostGeneration);
  const participant = useRef(`cached-server-tab:${crypto.randomUUID()}`);
  const currentDocumentId = useRef(documentId);
  currentDocumentId.current = documentId;
  const resourceIdentity = resourceHandle ?? documentId;
  const resourceLookup = useMemo(
    () =>
      resourceHandle
        ? ({ kind: "handle", handle: resourceHandle } as const)
        : ({ kind: "document", documentId } as const),
    [resourceIdentity],
  );
  const [local, setLocal] = useState<{
    identity: string;
    documentId: string;
    handle: ResourceContentHandle | null;
    phase: "probing" | "cached" | "server" | "failed";
  }>({ identity: resourceIdentity, documentId, handle: null, phase: "probing" });
  const currentLocal =
    local.identity === resourceIdentity
      ? local
      : {
          identity: resourceIdentity,
          documentId,
          handle: null,
          phase:
            local.documentId === documentId && local.phase === "server"
              ? ("server" as const)
              : ("probing" as const),
        };
  useEffect(() => {
    const abort = new AbortController();
    let retained: ResourceContentHandle | null = null;
    setLocal((prior) => ({
      identity: resourceIdentity,
      documentId,
      handle: null,
      phase: prior.documentId === documentId && prior.phase === "server" ? "server" : "probing",
    }));
    void (async () => {
      const requestedDocumentId = currentDocumentId.current;
      const settleUnavailable = async () => {
        try {
          const remote = await resources.canAcquireRemoteDocument(projectId, requestedDocumentId);
          if (!abort.signal.aborted)
            setLocal({
              identity: resourceIdentity,
              documentId,
              handle: null,
              phase: remote ? "server" : "failed",
            });
        } catch {
          if (!abort.signal.aborted)
            setLocal({ identity: resourceIdentity, documentId, handle: null, phase: "failed" });
        }
      };
      try {
        const key =
          resourceLookup.kind === "handle"
            ? { handle: resourceLookup.handle }
            : await resources.keyForDocument(projectId, resourceLookup.documentId);
        if (abort.signal.aborted) return;
        if (!key) {
          setLocal({ identity: resourceIdentity, documentId, handle: null, phase: "server" });
          return;
        }
        const result = await resources.openDocument(
          projectId,
          key,
          participant.current,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        if (result.kind !== "opened") {
          await settleUnavailable();
          return;
        }
        retained = result.handle;
        setLocal({ identity: resourceIdentity, documentId, handle: retained, phase: "cached" });
      } catch {
        await settleUnavailable();
      }
    })();
    return () => {
      abort.abort();
      retained?.release();
    };
  }, [projectId, resourceIdentity, resourceLookup, resources]);
  const serverDocumentId = currentLocal.phase === "server" ? documentId : null;
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: serverDocumentId,
    owner: "desktop-server-tab",
  });
  useLiveBindingAcknowledgementHost(projectId, active ? serverDocumentId : null, binding);
  usePostApplyHostWake(projectId, serverDocumentId, generation.current);
  const state = binding.state;
  useEffect(() => {
    if (state.kind !== "opened" || state.documentId !== documentId) return;
    void resources
      .captureServerSession(projectId, documentId, state.generation, state.session)
      .catch(() => undefined);
  }, [documentId, projectId, resources, state]);
  const localSession = currentLocal.handle?.session ?? null;
  return children(
    localSession ??
      (state.kind === "opened" && state.documentId === documentId ? state.session : null),
    currentLocal.phase === "failed" || (state.kind === "failed" && state.documentId === documentId),
    localSession !== null,
  );
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
  onBecameNonEmpty: (documentId: string) => Promise<void>;
}) {
  useEffect(() => {
    const fragment = session.document.getXmlFragment(session.fragmentName);
    let armed = true;
    let observing = true;
    let pending = false;
    let retryTimer: number | null = null;
    const observe = () => {
      if (!armed || pending || resourceDocumentIsEmpty(fragment)) return;
      pending = true;
      void onBecameNonEmpty(documentId).then(
        () => {
          if (!armed) return;
          armed = false;
          fragment.unobserveDeep(observe);
          observing = false;
        },
        () => {
          pending = false;
          if (armed) retryTimer = window.setTimeout(observe, 1_000);
        },
      );
    };
    fragment.observeDeep(observe);
    // IndexedDB may already contain words if React remounted this tab.
    void session.whenLocalPersistenceSynced().then(observe);
    return () => {
      armed = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (observing) fragment.unobserveDeep(observe);
    };
  }, [documentId, onBecameNonEmpty, session]);
  return null;
}
