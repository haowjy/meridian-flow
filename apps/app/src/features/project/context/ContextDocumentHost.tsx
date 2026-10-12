/**
 * ContextDocumentHost — one editable document in a view: its session, its
 * editor, and the review room the controller asks for.
 *
 * The Editor's warm tab set and the dock's single document both render
 * through this, so they are two views of the same editor and differ only in
 * what they pass: whether the editor is painted (`shown`), whether the surface
 * is on screen (`active`, which stands down chrome that portals to the body),
 * and whether the document is frozen (`readOnly`). The host fills its
 * `relative` parent.
 */
import { Trans } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { refreshWorksSnapshot } from "@/client/query/works-projection-acquisition";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { Button } from "@/components/ui/button";
import type {
  DocumentSession,
  DocumentSessionAccess,
  DocumentSessionSnapshot,
} from "@/core/editor/document-session";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { EditorView } from "@/features/editor/EditorView";
import { cn } from "@/lib/utils";
import {
  useAccountResourceProjection,
  useLiveDocumentSessionRegistry,
} from "./account-feature-context";
import { ContextTabSessionBoundary, resourceAvailabilityRevision } from "./context-tab-session";
import { resourceDocumentIsEmpty } from "./resource-document-eligibility";

export type EditableContextTab = Extract<ContextTab, { kind: "tracked" | "new" }>;

export type ContextDocumentHostProps = {
  projectId: string;
  tab: EditableContextTab;
  /** False binds the session but paints no editor: a warm tab evicted from the mounted set. */
  mountEditor?: boolean;
  /** False keeps the editor mounted behind the front one, hidden. */
  shown?: boolean;
  /** Whether the surface is on screen; a hidden surface's chrome stands down. */
  active: boolean;
  readOnly?: boolean;
  onUntitledBecameNonEmpty?: (documentId: string) => Promise<void>;
  /** Overrides the editor shell's own styling, e.g. to take the dock's material. */
  editorClassName?: string;
};

export function ContextDocumentHost({
  projectId,
  tab,
  mountEditor = true,
  shown = true,
  active,
  readOnly = false,
  onUntitledBecameNonEmpty,
  editorClassName,
}: ContextDocumentHostProps) {
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  const { snapshot: resourceProjection } = useAccountResourceProjection(projectId);
  const bindingKeys = useRef(new WeakMap<object, string>());
  const availabilityRevision = resourceAvailabilityRevision(resourceProjection, tab.documentId);
  const selectedReviewDraftId =
    shown && controller.inlineReview?.documentId === tab.documentId
      ? controller.inlineReview.draftId
      : null;
  const reviewRoomName = selectedReviewDraftId
    ? reviewRoomNameForDraft(tab.documentId, selectedReviewDraftId)
    : null;
  const reviewDraftId = reviewRoomName ? selectedReviewDraftId : null;
  const waitingForReviewRoom = Boolean(selectedReviewDraftId && !reviewRoomName);
  // A draft-only document has no live room until Apply promotes it, and
  // the server refuses one. Review hosts the draft branch alone.
  const branchOnly = tab.kind === "tracked" && tab.draftOnly === true;
  const renderEditor = (
    session: DocumentSession | null,
    failed = false,
    localContentReady = false,
    retry?: () => void,
  ): ReactNode => {
    if (!mountEditor) return null;
    const hosted = session !== null || branchOnly;
    let bindingKey: string | undefined;
    if (session) {
      bindingKey = bindingKeys.current.get(session);
      if (!bindingKey) {
        bindingKey = `resource-editor:${crypto.randomUUID()}`;
        bindingKeys.current.set(session, bindingKey);
      }
    }
    return (
      <div
        data-context-editor-document-id={tab.documentId}
        className={cn(
          // Each editor fills the host's frame; only the active one is
          // visible. `hidden` keeps DOM/state alive without painting.
          "absolute inset-0 flex min-h-0 flex-col",
          shown ? "" : "hidden",
        )}
        // Defensive: aria-hidden hides background editors from AT.
        aria-hidden={!shown}
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
        {!failed && !hosted ? <DelayedContentSkeleton className="absolute inset-0" /> : null}
        {tab.kind === "new" && session && onUntitledBecameNonEmpty ? (
          <UntitledInputObserver
            documentId={tab.documentId}
            session={session}
            onBecameNonEmpty={onUntitledBecameNonEmpty}
          />
        ) : null}
        {/* Filename chrome is host-owned: the context tab strip names the
            active file, so EditorView renders no redundant header bar. */}
        {failed || !hosted ? null : waitingForReviewRoom && controller.reviewRoomError ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="surface-card max-w-sm space-y-3 rounded-lg border border-border-subtle p-4 text-center shadow-sm">
              <p className="font-medium text-foreground text-sm">
                <Trans>Couldn't open review mode.</Trans>
              </p>
              <p className="text-muted-foreground text-xs">
                {branchOnly ? (
                  <Trans>Try again, or close this tab. The draft stays in your list.</Trans>
                ) : (
                  <Trans>Try again, or return to the live document.</Trans>
                )}
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
                {branchOnly ? null : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => controller.exitInlineReview()}
                  >
                    <Trans>Back to live</Trans>
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          // While the review room resolves, the live editor stays on
          // screen (a draft-only tab has none, so its shell holds the place).
          <>
            {active && shown ? (
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
            <PresenceSuspension session={session} enabled={Boolean(reviewDraftId && active)} />
            <EditorView
              projectId={projectId}
              documentId={tab.documentId}
              session={session ?? undefined}
              bindingKey={bindingKey}
              // A warm editor is hidden, not gone. Its chrome portals to
              // the body, where `hidden` on an ancestor means nothing.
              active={active && shown}
              className={editorClassName}
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
              onReviewSessionUnavailable={branchOnly ? undefined : controller.exitInlineReview}
            />
          </>
        )}
      </div>
    );
  };
  return (
    <ContextTabSessionBoundary
      projectId={projectId}
      documentId={tab.documentId}
      resourceHandle={tab.resourceHandle}
      availabilityRevision={availabilityRevision}
      liveRoom={!branchOnly}
    >
      {renderEditor}
    </ContextTabSessionBoundary>
  );
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
