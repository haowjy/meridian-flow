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
  reviewDraftId?: string | null;
};

const REVIEW_MARKS_WAIT_MS = 1500;

export function EditorView(props: EditorViewProps) {
  const { controller, roomOwner } = useDraftReview();
  // Resolve once against the canonical scope binding, never host-mirrored room/Work fields.
  const requestedDraftId = props.reviewDraftId ?? null;
  const review =
    controller.inlineReview?.documentId === props.documentId &&
    controller.inlineReview.draftId === requestedDraftId
      ? controller.inlineReview
      : null;
  const reviewRequested = requestedDraftId !== null;
  const sharedIdentity = {
    documentId: props.documentId,
    projectId: props.projectId,
    schemaType: props.schemaType ?? "document",
    collaborationDecorations: props.showCollaborationDecorations ?? true,
  } as const;
  const liveIdentity: EditorMountIdentity = {
    ...sharedIdentity,
    bindingKey: props.bindingKey,
    surface: "live",
    detached: props.detached ?? false,
  };
  const identity: EditorMountIdentity | null = review?.roomName
    ? {
        ...sharedIdentity,
        surface: "review",
        roomName: review.roomName,
        workId: controller.workId,
        draftId: review.draftId,
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
  const liveSession = props.session ?? null;
  // The writer handled the last change. A Discard leaves live as it is, so the
  // finished text is already the live editor: shown in place of the review's at
  // the click, but inert, because nothing is known yet. The server's `draftClosed`
  // answer then makes it editable (the draft's text is the live text and its
  // room a dead generation; the review chrome stays, saying so). An answer that
  // did not close the draft withdraws it and the review comes back. A last Apply
  // keeps the review's editor, marks gone, until that answer: live has no change
  // in it before.
  const completion = review?.completion;
  const closed = completion?.phase === "closed";
  const settled =
    identity !== null &&
    liveSession !== null &&
    (closed || (completion?.phase === "pending" && completion.mode === "discard"));
  const [marksWaitOverFor, setMarksWaitOverFor] = useState<string | null>(null);
  const reviewSession = identity && !settled ? roomOwner.session : null;
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
  // The editor existing is not enough: the review shows with its marks, in one
  // frame, so the writer never sees the draft text unmarked.
  const reviewVisible = reviewPainted && (marksReady || marksWaitOverFor === reviewKey);
  useEffect(() => {
    if (!reviewPainted || marksReady || !reviewKey) return;
    const timer = window.setTimeout(() => setMarksWaitOverFor(reviewKey), REVIEW_MARKS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [reviewPainted, marksReady, reviewKey]);

  // Review chrome (the header, the chip swap) shows with the review body and
  // never before it. A layout effect, so the controller's update lands before
  // paint, in the same frame as the body swap above.
  const chromeShown = reviewVisible || settled;
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!review) return;
    setInlineReviewShown(props.documentId, review.draftId, chromeShown);
  }, [setInlineReviewShown, props.documentId, review?.draftId, chromeShown]);

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
  const terminal = review?.roomError || schemaStale || (props.draftOnly && !reviewRequested);
  const liveKey = liveSession ? `${editorMountKey(liveIdentity)}|${liveSession.document.guid}` : "";
  const surface = terminal
    ? "review-error"
    : settled
      ? `live:${liveKey}`
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
                editable: reviewRequested && !closed ? false : props.editable,
                held: !liveVisible || (reviewRequested && !closed),
              }}
              session={liveSession}
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
              editor={reviewEditor}
              onModelAvailable={(identity, documentId, draftId) => {
                setConstructed((current) =>
                  current?.key === reviewKey && !current.modelReady
                    ? { ...current, modelReady: true }
                    : current,
                );
                controller.inlineReviewModelAvailable(identity, documentId, draftId);
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
          {props.reviewDraftId ? (
            <Trans>Couldn't open review mode.</Trans>
          ) : (
            <Trans>Couldn't open this draft.</Trans>
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          {props.draftOnly ? (
            <Trans>Try again, or close this tab. The draft stays in your list.</Trans>
          ) : (
            <Trans>Try again, or return to the live document.</Trans>
          )}
        </p>
        <div className="flex justify-center gap-2">
          {props.reviewDraftId ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                controller.enterInlineReview(props.documentId, props.reviewDraftId as string)
              }
            >
              <Trans>Retry</Trans>
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

/** Only a review mounts subscriptions and claims the controller's runtime slot. */
function ReviewRuntime({
  review,
  editor,
  onModelAvailable,
}: {
  review: InlineDraftReview;
  editor: Editor | null;
  onModelAvailable: (identity: string, documentId: string, draftId: string) => void;
}) {
  const { controller } = useDraftReview();
  const { registerInlineReviewRuntime, releaseInlineReviewRuntime } = controller;
  useEffect(() => {
    if (!editor) return;
    registerInlineReviewRuntime({ editor, documentId: review.documentId, draftId: review.draftId });
    return () => releaseInlineReviewRuntime(editor);
  }, [
    registerInlineReviewRuntime,
    releaseInlineReviewRuntime,
    editor,
    review.documentId,
    review.draftId,
  ]);
  useInlineReviewSync({
    editor,
    projectId: controller.projectId,
    workId: controller.workId,
    documentId: review.documentId,
    draftId: review.draftId,
    draftGeneration: review.draftGeneration,
    onInlineModelAvailable: onModelAvailable,
  });
  useInlineReviewFocus({
    editor,
    documentId: review.documentId,
    draftId: review.draftId,
  });
  return null;
}
