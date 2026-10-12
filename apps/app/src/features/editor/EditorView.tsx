/** Review composition over a warm live editor and the scope owner's addressed branch binding. */
import { Trans } from "@lingui/react/macro";
import { operationKey, type ReviewOperation } from "@meridian/contracts/drafts";
import { WS_CLOSE, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  draftCommandKey,
  intentKeys,
  selectionKeys,
  useChangeCommandRecords,
} from "@/client/query/draft-command-record";
import {
  PaintCapture,
  PaintScope,
  useAfterPaintRelease,
  usePaintCoverProjection,
} from "@/components/app/PaintHold";
import { Button } from "@/components/ui/button";
import type { DocumentSession, DocumentSessionSnapshot } from "@/core/editor/document-session";
import { projectRestoring } from "@/core/editor/extensions/inline-review";
import { type EditorMountIdentity, editorMountKey } from "@/core/editor/mounted-editor";
import {
  annotateCoverBlocks,
  type CoverView,
  dropReviewPlace,
  hasReviewPlace,
  readCoverView,
  restoreReviewPlaceWhenMeasured,
} from "@/core/editor/review-place";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { InlineDraftReview } from "@/features/draft-review/draft-review-session";
import { ReviewPlaceCapture, useEditorFocusOwned } from "./ReviewPlaceCapture";
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
  // The writer's place is held while a draft generation (or the live editor)
  // replaces the editor they were in, and restored over the successor. So the
  // successor shows only once the writer's unsent edits have reached it: the
  // place may sit inside them.
  const draftKey = review ? `${review.documentId}:${review.draftId}` : null;
  const placeHeld = draftKey !== null && hasReviewPlace(draftKey);
  // Cached preview availability does not certify a replacement editor's projection.
  const marksReady = constructed?.key === reviewKey && constructed.modelReady;
  const settledEnough = marksReady && !(placeHeld && roomOwner.carryPending);
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
  const terminal = review?.roomError || schemaStale || (props.draftOnly && !reviewRequested);

  // Review chrome (the header, its change list, the phone's sheet) shows with
  // the review body and never before it, and then stays for the draft: a new
  // generation replacing the body leaves it as it is. A layout effect, so the
  // controller's update lands before paint, in the same frame as the body swap.
  const chromeShown = (reviewVisible || settled || review?.shown === true) && !terminal;
  const { setInlineReviewShown } = controller;
  useLayoutEffect(() => {
    if (!review) return;
    setInlineReviewShown(props.documentId, review.draftId, chromeShown);
  }, [setInlineReviewShown, props.documentId, review?.draftId, chromeShown]);
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

  // The place the writer held in the editor that just left (see `ReviewPlaceCapture`)
  // goes into whichever editor takes over once nothing covers it: the review
  // successor, or the warm live editor a finished review hands the page to.
  const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
  const placedEditor = reviewOnScreen ? reviewEditor : settled && liveVisible ? liveEditor : null;
  const focusOwned = useEditorFocusOwned(reviewOnScreen ? reviewEditor : null);
  const afterPaintRelease = useAfterPaintRelease();
  useLayoutEffect(() => {
    if (!draftKey || !placedEditor) return;
    afterPaintRelease((cover) =>
      restoreReviewPlaceWhenMeasured(
        draftKey,
        placedEditor,
        cover.read as CoverView | null | undefined,
      ),
    );
  }, [draftKey, placedEditor, surface, closed, afterPaintRelease]);
  useEffect(
    () => () => {
      if (draftKey) dropReviewPlace(draftKey);
    },
    [draftKey],
  );

  // A cover standing in for the old review is a capture plus the writer's
  // intents as they are now (`PaintHold.projectCover`): a Discard accepted under
  // it shows its original there, and one refused is drawn as it was. What the
  // old review's operations were is read when the cover is built.
  const shownModels = useRef(new Map<string, readonly ReviewOperation[]>());
  const lastShownKey = useRef<string | null>(null);
  if (reviewOnScreen) lastShownKey.current = reviewKey;
  const commandRecords = useChangeCommandRecords();
  const draftRef = review
    ? {
        projectId: controller.projectId,
        workId: controller.workId,
        documentId: review.documentId,
        draftId: review.draftId,
      }
    : null;
  // The Discards this cover's review has had since it was on screen. A Discard
  // that went through leaves the intents once the server has answered, but the
  // review it was made in is still what the cover shows until the next generation
  // paints; one the server refused is withdrawn.
  const discarded = useRef<{ review: string | null; keys: Set<string> }>({
    review: null,
    keys: new Set(),
  });
  if (discarded.current.review !== lastShownKey.current)
    discarded.current = { review: lastShownKey.current, keys: new Set() };
  if (draftRef) {
    const { restoring } = intentKeys(commandRecords, draftRef);
    for (const key of restoring) discarded.current.keys.add(key);
    for (const record of Object.values(
      commandRecords.drafts[draftCommandKey(draftRef)]?.outcomes ?? {},
    ))
      if (record.phase === "failed")
        for (const key of selectionKeys(record))
          if (!restoring.has(key)) discarded.current.keys.delete(key);
  }
  const discardedKey = [...discarded.current.keys].sort().join("|");
  const projectCover = usePaintCoverProjection();
  const projectIntents = useCallback((cover: HTMLElement) => {
    const operations = shownModels.current.get(lastShownKey.current ?? "") ?? [];
    projectRestoring(
      cover,
      new Set(
        operations
          .filter((op) => discarded.current.keys.has(operationKey(op)))
          .map((op) => op.operationId),
      ),
    );
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the intents moving is what rebuilds a cover.
  useLayoutEffect(
    () =>
      projectCover({ annotate: annotateCoverBlocks, project: projectIntents, read: readCoverView }),
    [projectCover, projectIntents, discardedKey],
  );
  useEffect(() => () => projectCover(null), [projectCover]);
  return (
    <>
      <PaintCapture surface={surface} state={surface === "pending" ? "pending" : "painted"} />
      <ReviewPlaceCapture
        surface={surface}
        editor={reviewOnScreen ? reviewEditor : null}
        draftKey={draftKey}
        focusOwned={focusOwned}
      />
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
              onConstructed={setLiveEditor}
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
              onModelAvailable={(identity, documentId, draftId, operations) => {
                if (operations) {
                  shownModels.current.set(reviewKey, operations);
                  for (const key of shownModels.current.keys())
                    if (key !== reviewKey && key !== lastShownKey.current)
                      shownModels.current.delete(key);
                }
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
  onModelAvailable: (
    identity: string,
    documentId: string,
    draftId: string,
    operations?: readonly ReviewOperation[],
  ) => void;
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
