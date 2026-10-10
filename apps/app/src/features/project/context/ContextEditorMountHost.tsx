/** ContextEditorMountHost — hosts the *active* TRACKED context document with a bounded "keep-warm" set of recently-viewed editors. */
import { Trans } from "@lingui/react/macro";
import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { refreshWorksSnapshot } from "@/client/query/works-projection-acquisition";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import { Button } from "@/components/ui/button";
import type {
  DocumentSession,
  DocumentSessionAccess,
  DocumentSessionSnapshot,
} from "@/core/editor/document-session";
import type { ResourceContentHandle } from "@/core/resources/resource-content-access";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { EditorView } from "@/features/editor/EditorView";
import { cn } from "@/lib/utils";
import { useRequestedReview } from "../dock/editor-review-handoff";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useContextRemovalCoordinator,
  useLiveDocumentSessionRegistry,
} from "./account-feature-context";
import { resourceDocumentIsEmpty } from "./resource-document-eligibility";
import { useLiveDocumentBinding } from "./use-live-document-binding";
import { useRefusedEditsReopen } from "./use-refused-edits-reopen";

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
  trackedTabs,
  activeTabId,
  active,
  onUntitledBecameNonEmpty,
  readOnly = false,
}: ContextEditorMountHostProps) {
  const removal = useContextRemovalCoordinator();
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  const activeTab = trackedTabs.find((tab) => tab.documentId === activeTabId);
  const requestedReview = useRequestedReview({
    editorWorkId: controller.workId,
    activeScheme: activeTab?.kind === "tracked" ? activeTab.scheme : null,
    documentId: activeTabId,
  });
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
        const selectedReviewDraftId = isActive ? requestedReview : null;
        const reviewRoomName = selectedReviewDraftId
          ? reviewRoomNameForDraft(tab.documentId, selectedReviewDraftId)
          : null;
        const reviewDraftId = reviewRoomName ? selectedReviewDraftId : null;
        // A draft-only document has no live room until Apply promotes it, and
        // the server refuses one. Review hosts the draft branch alone.
        const branchOnly = tab.kind === "tracked" && tab.draftOnly === true;
        const renderEditor = (
          session: DocumentSession | null,
          failed = false,
          localContentReady = false,
          retry?: () => void,
        ): ReactNode => {
          if (!isMounted) return null;
          const hosted = session !== null || branchOnly;
          const surface = failed ? "failed" : hosted ? "painted" : "pending";
          let bindingKey: string | undefined;
          if (session) {
            bindingKey = bindingKeysRef.current.get(session);
            if (!bindingKey) {
              bindingKey = `resource-editor:${crypto.randomUUID()}`;
              bindingKeysRef.current.set(session, bindingKey);
            }
          }
          return (
            <PaintScope active={isActive}>
              <PaintCapture surface={surface} state={surface} />
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
                aria-busy={!failed && !hosted}
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
                {!failed && !hosted ? (
                  <DelayedContentSkeleton className="absolute inset-0" />
                ) : null}
                {tab.kind === "new" && session && onUntitledBecameNonEmpty ? (
                  <UntitledInputObserver
                    documentId={tab.documentId}
                    session={session}
                    onBecameNonEmpty={onUntitledBecameNonEmpty}
                  />
                ) : null}
                {/* Filename chrome is host-owned: the context tab strip names the
                  active file, so EditorView renders no redundant header bar. */}
                {failed || !hosted ? null : (
                  <>
                    {active && isActive ? (
                      <>
                        <ActiveEditorProjection
                          documentId={tab.documentId}
                          session={session}
                          inReview={Boolean(reviewDraftId)}
                          setProjection={setActiveEditorDocumentId}
                        />
                        <RoomScopeCatalogCheck
                          projectId={projectId}
                          session={session}
                          reviewRoomName={reviewRoomName}
                          readOnly={readOnly}
                        />
                      </>
                    ) : null}
                    <PresenceSuspension
                      session={session}
                      enabled={Boolean(reviewDraftId && active)}
                    />
                    <EditorView
                      draftOnly={branchOnly}
                      onCloseDraftOnly={() => {
                        const closing = removal.writerClose(projectId, tab.documentId);
                        if (closing instanceof Promise) closing.catch(reportError);
                      }}
                      projectId={projectId}
                      documentId={tab.documentId}
                      session={session ?? undefined}
                      bindingKey={bindingKey}
                      // A warm editor is hidden, not gone. Its chrome portals to
                      // the body, where `hidden` on an ancestor means nothing.
                      active={active && isActive}
                      editable={!readOnly}
                      showToolbar={!readOnly}
                      detached={tab.kind === "new"}
                      localContentReady={localContentReady}
                      schemaType={tab.kind === "tracked" ? tab.schemaType : "document"}
                      // The intent, not the resolved room: the live editor goes
                      // read-only from the click, while the room is still resolving.
                      reviewDraftId={selectedReviewDraftId}
                      reviewRoomName={reviewRoomName}
                      reviewWorkId={reviewDraftId ? controller.workId : null}
                      // Leaving review would strand a draft-only tab on an empty
                      // editor; the writer closes it from the tab bar instead.
                      // A room the server has moved past is not the end of the review,
                      // a draft-only one included: the review reads the current room.
                    />
                  </>
                )}
              </div>
            </PaintScope>
          );
        };
        return (
          <ContextTabSessionBoundary
            key={tab.tabInstanceId ?? tab.documentId}
            projectId={projectId}
            documentId={tab.documentId}
            resourceHandle={resourceHandle}
            availabilityRevision={availabilityRevision}
            liveRoom={!branchOnly}
          >
            {renderEditor}
          </ContextTabSessionBoundary>
        );
      })}
    </div>
  );
}

type ContextTabSessionProps = {
  projectId: string;
  documentId: string;
  resourceHandle?: string;
  availabilityRevision: string;
  /** False for a document with no live room yet (draft-only until Apply promotes it). */
  liveRoom?: boolean;
  children: (
    session: DocumentSession | null,
    failed: boolean,
    localContentReady: boolean,
    retry: () => void,
  ) => ReactNode;
};

/**
 * One stable host across local adoption; server retention lasts until the tab
 * closes. A room dropped because the server refused its edits reopens as a
 * fresh session: local probe and server binding both start over.
 */
export function ContextTabSessionBoundary(props: ContextTabSessionProps) {
  const [opening, setOpening] = useState(0);
  const reopen = useCallback(() => setOpening((value) => value + 1), []);
  return <ContextTabSession key={opening} {...props} onReopen={reopen} />;
}

function ContextTabSession({
  projectId,
  documentId,
  resourceHandle,
  availabilityRevision,
  liveRoom = true,
  children,
  onReopen,
}: ContextTabSessionProps & { onReopen: () => void }) {
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
  // A tab can lose its resource handle while keeping its document (a review
  // launch re-opens it without one). Same document, same cached session: keep
  // painting it while the exact lookup re-probes, never drop to a skeleton.
  const currentLocal =
    local.identity === resourceIdentity
      ? local
      : {
          identity: resourceIdentity,
          documentId,
          handle: local.documentId === documentId ? local.handle : null,
          phase:
            local.documentId === documentId && local.phase === "server"
              ? ("server" as const)
              : ("probing" as const),
        };
  useEffect(() => {
    if (!liveRoom) return;
    const abort = new AbortController();
    setLocal((prior) => ({
      identity: resourceIdentity,
      documentId,
      handle:
        prior.identity === resourceIdentity || prior.documentId === documentId
          ? prior.handle
          : null,
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
  }, [availabilityRevision, liveRoom, projectId, resourceIdentity, resourceLookup, resources]);
  useEffect(
    () => () => {
      installedHandle.current?.release();
      installedHandle.current = null;
    },
    [],
  );
  const binding = useLiveDocumentBinding({
    projectId,
    documentId: liveRoom && currentLocal.phase === "server" ? documentId : null,
    owner: "desktop-server-tab",
  });
  const automaticRetryRevision = useRef(availabilityRevision);
  useEffect(() => {
    if (binding.state.kind !== "failed" || automaticRetryRevision.current === availabilityRevision)
      return;
    automaticRetryRevision.current = availabilityRevision;
    binding.retry();
  }, [availabilityRevision, binding.retry, binding.state.kind]);
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
  const session = useRefusedEditsReopen(selectedSession, onReopen);
  return children(
    session,
    state.kind === "failed" && state.documentId === documentId,
    selectedSession !== null && selectedSession === localSession,
    binding.retry,
  );
}

export function resourceAvailabilityRevision(
  snapshot: ResourceProjectionSnapshot | null,
  documentId: string,
): string {
  if (!snapshot) return "pending";
  const resource = snapshot.records.find(
    (record) => record.resource.identity.documentId === documentId,
  )?.resource;
  return JSON.stringify([
    resource?.revision ?? null,
    resource?.lifecycle.kind === "acknowledged"
      ? resource.lifecycle.availabilityGeneration
      : resource?.lifecycle.kind === "terminal"
        ? resource.lifecycle.generation
        : null,
  ]);
}

function ActiveEditorProjection({
  documentId,
  session,
  inReview,
  setProjection,
}: {
  documentId: string;
  /** Null while a draft-only document is hosted by its branch room alone. */
  session: DocumentSession | null;
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

/**
 * A room's scope follows its Work: an archived Work's draft and scratch are
 * read-only (D33). The front editor already follows its room; when the server
 * names a scope that `readOnly` doesn't show, this tab's Works catalog is
 * behind (another tab archived or unarchived the Work), and the archived
 * notice, its Unarchive and `readOnly` all come from it. Asked on activation
 * and on each named scope; this tab's own `readOnly` changes (its archive
 * command) never ask, because the room's next scope confirms them. A review
 * watches the draft's room, never the live one it reviews against.
 */
function RoomScopeCatalogCheck({
  projectId,
  session,
  reviewRoomName,
  readOnly,
}: {
  projectId: string;
  /** Null while a draft-only document is hosted by its branch room alone. */
  session: DocumentSession | null;
  reviewRoomName: string | null;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const registry = useLiveDocumentSessionRegistry();
  const [access, setAccess] = useState<DocumentSessionAccess | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  useEffect(() => {
    const observer = (snapshot: DocumentSessionSnapshot) => setAccess(snapshot.access);
    return reviewRoomName
      ? registry.observeBranchRoom(reviewRoomName, observer)
      : session?.subscribe(observer);
  }, [registry, reviewRoomName, session]);
  useEffect(() => {
    if (access === null || (access === "read") === readOnlyRef.current) return;
    void refreshWorksSnapshot(queryClient, projectId).catch(() => undefined);
  }, [access, projectId, queryClient]);
  return null;
}

function PresenceSuspension({
  session,
  enabled,
}: {
  session: DocumentSession | null;
  enabled: boolean;
}) {
  useEffect(() => {
    if (!enabled || !session) return;
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
