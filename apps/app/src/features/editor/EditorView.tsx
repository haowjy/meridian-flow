/** Review composition over a warm live editor and the scope owner's addressed branch binding. */
import { Trans } from "@lingui/react/macro";
import { WS_CLOSE, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PaintCapture, PaintScope } from "@/components/app/PaintHold";
import { Button } from "@/components/ui/button";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { type EditorMountIdentity, editorMountKey } from "@/core/editor/mounted-editor";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { InlineDraftReview } from "@/features/draft-review/draft-review-session";
import type { ReviewSurface } from "@/features/draft-review/review-runtime";
import { type EditorSurfaceOptions, PendingEditorShell, SessionEditor } from "./SessionEditor";
import { useInlineReviewFocus } from "./useInlineReviewFocus";
import { useInlineReviewSync } from "./useInlineReviewSync";

export type EditorViewProps = Omit<EditorSurfaceOptions, "held"> & {
  documentId: string;
  draftOnly?: boolean;
  onCloseDraftOnly?: () => void;
  /** Exact host-owned live/local session; absent for a draft-only destination. */
  session?: DocumentSession;
  bindingKey?: string;
  detached?: boolean;
  projectId?: string;
  schemaType?: YjsTrackedSchemaType;
  showCollaborationDecorations?: boolean;
  /** Requested destination, including while the canonical room is still resolving. */
  reviewItemKey?: string | null;
  /** The hosting tab instance, whose focus-on-open intent the live editor claims. */
  focusKey?: string;
  /** Which host mounts this editor; the dock's is "dock". */
  reviewSurface?: ReviewSurface;
};

const REVIEW_MARKS_WAIT_MS = 1500;

/** What the editor body shows: the card only for a failed review room. */
type EditorSurface = "pending" | "review-error" | `live:${string}` | `review:${string}`;

export function EditorView(props: EditorViewProps) {
  const { controller, roomOwner } = useDraftReview();
  // Resolve once against the canonical scope binding, never host-mirrored room/Work fields.
  const requestedItemKey = props.reviewItemKey ?? null;
  const review =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.itemKey === requestedItemKey
      ? controller.inlineReview
      : null;
  const reviewRequested = requestedItemKey !== null;
  const sharedIdentity = {
    documentId: props.documentId,
    projectId: props.projectId,
    viewingWorkId: controller.workId || undefined,
    schemaType: props.schemaType ?? "document",
    collaborationDecorations: props.showCollaborationDecorations ?? true,
  } as const;
  const liveIdentity: EditorMountIdentity = {
    ...sharedIdentity,
    bindingKey: props.bindingKey,
    surface: "live",
    detached: props.detached ?? false,
  };
  const identity: EditorMountIdentity | null =
    review && roomOwner.roomName
      ? {
          ...sharedIdentity,
          surface: "review",
          roomName: roomOwner.roomName,
          workId: controller.workId,
          itemKey: review.itemKey,
        }
      : null;
  const surfaceOptions: EditorSurfaceOptions = {
    className: props.className,
    editable: props.editable,
    showToolbar: props.showToolbar,
    active: props.active,
    ariaLabel: props.ariaLabel,
    localContentReady: props.localContentReady,
  };
  const historySurface = props.reviewSurface ?? "editor";
  const liveSession = props.session ?? null;
  const [marksWaitOverFor, setMarksWaitOverFor] = useState<string | null>(null);
  const reviewSession = identity ? roomOwner.session : null;
  const reviewKey =
    identity && reviewSession ? `${editorMountKey(identity)}|${reviewSession.document.guid}` : null;
  const [constructed, setConstructed] = useState<{
    key: string;
    editor: Editor;
    modelReady: boolean;
  } | null>(null);
  const constructionTarget = useRef(reviewKey);
  constructionTarget.current = reviewKey;
  const reviewEditor = constructed?.key === reviewKey ? constructed.editor : null;
  const reviewPainted = reviewEditor !== null;
  // Cached preview availability does not certify a replacement editor's projection.
  const marksReady = constructed?.key === reviewKey && constructed.modelReady;
  const settledEnough = marksReady;
  // The editor existing is not enough: the review shows with its marks, in one
  // frame, so the writer never sees the draft text unmarked.
  const reviewVisible = reviewPainted && (settledEnough || marksWaitOverFor === reviewKey);
  useEffect(() => {
    if (!reviewPainted || settledEnough || !reviewKey) return;
    const timer = window.setTimeout(() => setMarksWaitOverFor(reviewKey), REVIEW_MARKS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [reviewPainted, settledEnough, reviewKey]);

  const [reviewSnapshot, setReviewSnapshot] = useState<{
    session: DocumentSession | null;
    snapshot: DocumentSessionSnapshot | null;
  }>({ session: null, snapshot: null });
  useLayoutEffect(
    () =>
      reviewSession?.subscribe((snapshot) =>
        setReviewSnapshot({ session: reviewSession, snapshot }),
      ),
    [reviewSession],
  );
  const snapshot =
    reviewSnapshot.session === reviewSession
      ? reviewSnapshot.snapshot
      : reviewSession?.getSnapshot();
  const schemaStale =
    snapshot?.connectionState?.kind === "reset" &&
    snapshot.connectionState.reason === WS_CLOSE.DOCUMENT_SCHEMA_STALE.reason;
  // Only a failed review room is terminal. A draft-only tab whose route has no
  // review item yet is `pending`; a gone draft is the lifecycle closing its tab.
  const terminal = review?.roomError || schemaStale;

  // Review chrome (the header, its change list, the phone's sheet) shows with
  // the review body and never before it, and then stays for the draft, even
  // if the body is rebuilt. A layout effect, so the
  // controller's update lands before paint, in the same frame as the body swap.
  const chromeShown = (reviewVisible || review?.shown === true) && !terminal;
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!review) return;
    setInlineReviewShown(props.documentId, review.itemKey, chromeShown);
  }, [setInlineReviewShown, props.documentId, review?.itemKey, chromeShown]);
  const liveKey = liveSession ? `${editorMountKey(liveIdentity)}|${liveSession.document.guid}` : "";
  const surface: EditorSurface = terminal
    ? "review-error"
    : reviewVisible
      ? `review:${reviewKey}`
      : reviewRequested || !liveSession
        ? "pending"
        : `live:${liveKey}`;
  const liveVisible = surface.startsWith("live:");
  const reviewOnScreen = surface.startsWith("review:");

  return (
    <>
      <PaintCapture surface={surface} state={surface === "pending" ? "pending" : "painted"} />
      {terminal ? (
        schemaStale ? (
          <p data-document-schema-stale>
            <Trans>This chapter is temporarily unavailable</Trans>
          </p>
        ) : (
          <ReviewError props={props} />
        )
      ) : null}
      {surface === "pending" ? <PendingEditorShell {...surfaceOptions} /> : null}
      {liveSession ? (
        <PaintScope active={liveVisible}>
          <div data-editor-surface="live" className={liveVisible ? "contents" : "hidden"}>
            <SessionEditor
              key={liveKey}
              identity={liveIdentity}
              surfaceOptions={{
                ...surfaceOptions,
                editable: reviewRequested ? false : props.editable,
                held: !liveVisible || reviewRequested,
              }}
              session={liveSession}
              focusKey={props.focusKey}
              historySurface={historySurface}
            />
          </div>
        </PaintScope>
      ) : null}
      {!terminal && identity && review && reviewSession && reviewKey ? (
        <PaintScope active={reviewOnScreen}>
          <div
            key={reviewKey}
            data-editor-surface="review"
            className={reviewOnScreen ? "contents" : "hidden"}
          >
            <SessionEditor
              identity={identity}
              session={reviewSession}
              historySurface={historySurface}
              surfaceOptions={{
                ...surfaceOptions,
                editable: roomOwner.inputEligible && reviewPainted ? props.editable : false,
              }}
              onConstructed={(editor) => {
                if (!editor) {
                  setConstructed((current) => (current?.key === reviewKey ? null : current));
                } else if (constructionTarget.current === reviewKey) {
                  setConstructed({ key: reviewKey, editor, modelReady: false });
                }
              }}
            />
            <ReviewRuntime
              review={review}
              session={reviewSession}
              editor={reviewEditor}
              surface={props.reviewSurface}
              onModelAvailable={(identity, documentId, itemKey) => {
                setConstructed((current) =>
                  current?.key === reviewKey && !current.modelReady
                    ? { ...current, modelReady: true }
                    : current,
                );
                controller.inlineReviewModelAvailable(identity, documentId, itemKey);
              }}
            />
          </div>
        </PaintScope>
      ) : null}
    </>
  );
}

function ReviewError({ props }: { props: EditorViewProps }) {
  const { controller } = useDraftReview();
  // Desktop draft-only failures retain review until Close. Phone server documents
  // can return to live; phone draft-only destinations reuse the desktop close policy.
  const closeUnavailable = props.draftOnly ? props.onCloseDraftOnly : controller.exitInlineReview;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="surface-card max-w-sm space-y-3 rounded-lg border border-border-subtle p-4 text-center shadow-sm">
        <p className="font-medium text-foreground text-sm">
          <Trans>Couldn't open review mode.</Trans>
        </p>
        <p className="text-muted-foreground text-xs">
          {props.draftOnly ? (
            <Trans>Try again, or close this tab. The draft stays in your list.</Trans>
          ) : (
            <Trans>Try again, or return to the live document.</Trans>
          )}
        </p>
        <div className="flex justify-center gap-2">
          {props.reviewItemKey ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                controller.enterInlineReview(props.documentId, props.reviewItemKey as string)
              }
            >
              <Trans>Retry</Trans>
            </Button>
          ) : null}
          {props.reviewItemKey &&
          controller.inlineReview?.documentId === props.documentId &&
          controller.inlineReview.itemKey === props.reviewItemKey ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={controller.dispositionLocked}
              onClick={() =>
                void controller.discard(props.documentId, props.reviewItemKey as string)
              }
            >
              <Trans>Discard draft</Trans>
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="ghost" onClick={closeUnavailable}>
            {props.draftOnly ? <Trans>Close</Trans> : <Trans>Back to live</Trans>}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Only a review mounts the projection and focus subscriptions. */
function ReviewRuntime({
  review,
  session,
  editor,
  surface,
  onModelAvailable,
}: {
  review: InlineDraftReview;
  session: DocumentSession;
  editor: Editor | null;
  surface?: ReviewSurface;
  onModelAvailable: (identity: string, documentId: string, itemKey: string) => void;
}) {
  useInlineReviewSync({
    editor,
    session,
    documentId: review.documentId,
    itemKey: review.itemKey,
    surface,
    onInlineModelAvailable: onModelAvailable,
  });
  useInlineReviewFocus({
    editor,
    documentId: review.documentId,
    itemKey: review.itemKey,
  });
  return null;
}
