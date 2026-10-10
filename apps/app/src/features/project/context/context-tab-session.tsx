/**
 * The session-bound half of an open document: one resource lookup, one live
 * room binding, one server-session capture. Editor tabs and the dock's
 * document both render through it, so a document has exactly one way to reach
 * its `DocumentSession` and no view owns a second Y.Doc, room or capture.
 */
import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSession } from "@/core/editor/document-session";
import type { ResourceContentHandle } from "@/core/resources/resource-content-access";
import { useAccountResourceReplica } from "./account-feature-context";
import { useLiveDocumentBinding } from "./use-live-document-binding";
import { useRefusedEditsReopen } from "./use-refused-edits-reopen";

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
    owner: "desktop-document-host",
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
