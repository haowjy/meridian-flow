/** ContextEditorMountHost — hosts the *active* TRACKED context document with a bounded "keep-warm" set of recently-viewed editors. */
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
import { useAccountResourceProjection, useAccountResourceReplica } from "./account-feature-context";
import { resourceDocumentIsEmpty } from "./resource-document-eligibility";
import { resourceAvailabilityRevision, useLiveDocumentBinding } from "./use-live-document-binding";

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
  const { snapshot: resourceProjection } = useAccountResourceProjection(projectId);
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
        const availabilityRevision = resourceAvailabilityRevision(
          resourceProjection,
          tab.documentId,
        );
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
          retry?: () => void,
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
                <div className="grid h-full place-items-center">
                  <div className="space-y-3 text-center">
                    <p className="text-destructive text-sm">
                      <Trans>Couldn't open this document.</Trans>
                    </p>
                    {retry ? (
                      <Button type="button" size="sm" variant="secondary" onClick={retry}>
                        <Trans>Retry</Trans>
                      </Button>
                    ) : null}
                  </div>
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
            availabilityRevision={availabilityRevision}
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
  availabilityRevision,
  children,
}: {
  projectId: string;
  documentId: string;
  resourceHandle?: string;
  availabilityRevision: string;
  children: (
    session: DocumentSession | null,
    failed: boolean,
    localContentReady: boolean,
    retry: () => void,
  ) => ReactNode;
}) {
  const resources = useAccountResourceReplica();
  const participant = useRef(`cached-server-tab:${crypto.randomUUID()}`);
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
    phase: "probing" | "cached" | "server";
  }>({ identity: resourceIdentity, documentId, handle: null, phase: "probing" });
  const installedHandle = useRef<ResourceContentHandle | null>(null);
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
    setLocal((prior) => ({
      identity: resourceIdentity,
      documentId,
      handle: prior.identity === resourceIdentity ? prior.handle : null,
      phase: prior.documentId === documentId && prior.phase === "server" ? "server" : "probing",
    }));
    void (async () => {
      const settleUnavailable = (releaseCachedHandle = false) => {
        if (!abort.signal.aborted) {
          if (releaseCachedHandle) {
            installedHandle.current?.release();
            installedHandle.current = null;
          }
          setLocal((prior) => ({
            identity: resourceIdentity,
            documentId,
            handle:
              !releaseCachedHandle && prior.identity === resourceIdentity ? prior.handle : null,
            phase: "server",
          }));
        }
      };
      try {
        const key =
          resourceLookup.kind === "handle"
            ? { handle: resourceLookup.handle }
            : await resources.keyForDocument(projectId, resourceLookup.documentId);
        if (abort.signal.aborted) return;
        if (!key) {
          settleUnavailable();
          return;
        }
        const result = await resources.openDocument(
          projectId,
          key,
          participant.current,
          abort.signal,
          { adoptionEligible: true },
        );
        if (abort.signal.aborted) {
          if (result.kind === "opened") result.handle.release();
          return;
        }
        if (result.kind !== "opened") {
          settleUnavailable(
            result.kind === "unavailable" &&
              ["terminal", "deleted", "schema-mismatch"].includes(result.reason),
          );
          return;
        }
        const previous = installedHandle.current;
        installedHandle.current = result.handle;
        setLocal({
          identity: resourceIdentity,
          documentId,
          handle: result.handle,
          phase: "cached",
        });
        previous?.release();
      } catch {
        settleUnavailable();
      }
    })();
    return () => {
      abort.abort();
    };
  }, [availabilityRevision, projectId, resourceIdentity, resourceLookup, resources]);
  useEffect(
    () => () => {
      installedHandle.current?.release();
      installedHandle.current = null;
    },
    [],
  );
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: currentLocal.phase === "server" ? documentId : null,
    availabilityRevision,
    owner: "desktop-server-tab",
  });
  const state = binding.state;
  useEffect(() => {
    if (state.kind !== "opened" || state.documentId !== documentId) return;
    void resources
      .captureServerSession(projectId, documentId, state.generation, state.session)
      .catch(() => undefined);
  }, [documentId, projectId, resources, state]);
  const localSession = currentLocal.handle?.session ?? null;
  const liveSession =
    state.kind === "opened" && state.documentId === documentId ? state.session : null;
  const selectedSession = liveSession ?? localSession;
  return children(
    selectedSession,
    state.kind === "failed" && state.documentId === documentId,
    selectedSession !== null && selectedSession === localSession,
    binding.retry,
  );
}

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
