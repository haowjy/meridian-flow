/**
 * DocumentHost — one document in a view, on the desktop or the phone. The host is keyed by its
 * document: moving it between main and the side changes only its place, so its editor (undo,
 * caret, scroll) survives the move. Main's host also binds the address to its document and
 * records the opening; a host off main does neither.
 *
 * A `kept` host is the last document shown that is on screen no longer, mounted hidden so its
 * undo survives a return: it reviews nothing, presents nothing, and writes neither a pin nor the
 * address.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import { AlertCircle, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import type { OpenDocument } from "@/client/stores";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import { UnsentDraftTextNotice } from "@/features/draft-review/UnsentDraftTextNotice";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import {
  DocumentStatePortal,
  DocumentStateSlotProvider,
} from "@/features/editor/document-state-slot";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { cn } from "@/lib/utils";
import { DocumentReviewProvider } from "../DocumentReview";
import { MobileDocumentReview } from "../mobile/MobileDocumentReview";
import { MobileRefusalNotice } from "../mobile/MobileRefusalNotice";
import { PanePlaceContext } from "../pane-place";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { contextRouteRequest } from "../routing/project-route";
import { pageSheetClass } from "../shell/tab-chip";
import type { MainDocument } from "../views";
import {
  useContextRemovalCoordinator,
  useOptionalPresentedDocuments,
} from "./account-feature-context";
import { ContextDocumentHost, type EditableOpenDocument } from "./ContextDocumentHost";
import { ContextViewerHost } from "./ContextViewerHost";
import { DocumentFreezeNotice } from "./DocumentFreezeNotice";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { DocumentPaneChrome } from "./DocumentPaneChrome";
import { PHONE_DOCUMENT_PRESENTATION } from "./document-presentation";
import { LiveDraftNotice } from "./LiveDraftNotice";
import { placeTab } from "./open-document-from-file";
import type { MountedPlace } from "./presented-documents";
import { recentOpening } from "./recent-opening";
import { useDocumentFreeze } from "./use-document-freeze";
import { useDocumentLiveness } from "./use-draft-only-presentation";
import {
  type IdentityCommitOwnership,
  type IdentityCommitted,
  identityCommitMayNavigate,
  identityCommitRoute,
} from "./use-identity-commit";
import { useIsDraftOnly } from "./use-is-draft-only";
import { useRecordOpenedDocument } from "./use-record-opened-document";

export type DocumentPlace = MountedPlace;

export type DocumentHostProps = {
  projectId: string;
  document: OpenDocument;
  place: DocumentPlace;
  /** Whether the host's slot is on screen: main always, the side while it is open. */
  visible: boolean;
  /** Main's address answer; set only while the host is main's. */
  main?: MainDocument;
  presentation: "desktop" | "phone";
  /** The band above the page: main's header or the side's. On the phone only the sheet has one. */
  header?: ReactNode;
  editorWorkId: string | null;
  /**
   * The draft whose review controls take the focus when they show (desktop): the draft an Apply
   * or Next draft from another draft's controls opens. Held above the hosts, since each
   * document has its own.
   */
  focusReview?: string | null;
  onFocusReview?: (itemKey: string | null) => void;
};

export function DocumentHost(props: DocumentHostProps) {
  const { projectId, place } = props;
  const tab = useCurrentDescriptor(projectId, props.document, place === "main");
  const onScreen = place !== "kept" && props.visible;
  useMountDocument(projectId, tab, place);
  return (
    <PanePlaceContext.Provider value={place === "side" ? "side" : "main"}>
      <DocumentReviewProvider projectId={projectId} document={tab} showing={onScreen}>
        {place === "main" && props.main ? (
          <MainDocumentBinding projectId={projectId} document={tab} main={props.main} />
        ) : null}
        {props.presentation === "phone" ? (
          place === "main" ? (
            <PhoneDocumentFrame projectId={projectId} document={tab} local={false} />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              {props.header}
              <div className="min-h-0 flex-1">
                <PhoneDocumentFrame projectId={projectId} document={tab} local={false} />
              </div>
            </div>
          )
        ) : (
          <DesktopDocumentFrame {...props} document={tab} onScreen={onScreen} />
        )}
      </DocumentReviewProvider>
    </PanePlaceContext.Provider>
  );
}

/**
 * Off main, a host follows its document through a rename or a move by the replica's
 * placement; main's host gets the same from its address, which follows the document.
 */
function useCurrentDescriptor(projectId: string, tab: OpenDocument, main: boolean): OpenDocument {
  const trees = useProjectTrees(projectId);
  const isDraftOnly = useIsDraftOnly(projectId);
  if (main) return tab;
  const found = trees.find(tab.documentId);
  const placed = placeTab(
    found && { scheme: found.source.scheme, file: found.file, owner: ownerOfSource(found.source) },
    trees.isComplete,
    isDraftOnly(tab.documentId),
  );
  return placed.kind === "projected" ? placed.document : tab;
}

/** Main's and the side's documents are what removals, notices and availability act on. */
function useMountDocument(projectId: string, tab: OpenDocument, place: DocumentPlace) {
  const presented = useOptionalPresentedDocuments();
  const [token] = useState(() => crypto.randomUUID());
  useLayoutEffect(() => {
    presented?.mount(token, projectId, tab, place);
  }, [presented, token, projectId, tab, place]);
  useLayoutEffect(() => () => presented?.unmount(token), [presented, token]);
}

/**
 * Records main's route once live has its document, and the opening in Recent. Renders nothing.
 */
function MainDocumentBinding({
  projectId,
  document,
  main,
}: {
  projectId: string;
  document: OpenDocument;
  main: MainDocument;
}) {
  const contextRemoval = useContextRemovalCoordinator();

  // The route is remembered once main paints this document live; a draft-only document's path
  // dies with its draft, so it never is.
  const liveness = useDocumentLiveness(projectId, document);
  useLayoutEffect(() => {
    if (
      main.local ||
      main.draftOnly ||
      main.isFetching ||
      main.isError ||
      liveness === "draft-only" ||
      document.kind === "new" ||
      main.scheme === null ||
      main.path === null
    )
      return;
    contextRemoval.recordRoute(
      projectId,
      document.documentId,
      contextRouteRequest({
        scheme: main.scheme,
        path: main.path,
        workId: main.workId,
        rootThreadId: main.rootThreadId,
      }),
    );
  }, [
    contextRemoval,
    projectId,
    document.documentId,
    document.kind,
    main.local,
    main.draftOnly,
    main.isFetching,
    main.isError,
    main.scheme,
    main.path,
    main.workId,
    main.rootThreadId,
    liveness,
  ]);

  // Recency is recorded from the document actually in main, once per arrival.
  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (liveness !== "live") {
      recorded.current = null;
      return;
    }
    if (recorded.current === document.documentId) return;
    const opening = recentOpening(projectId, document, new Date().toISOString(), false);
    if (!opening) return;
    recorded.current = document.documentId;
    record(opening);
  }, [liveness, document, projectId, record]);
  return null;
}

/** Desktop: the band, then the page (the side's inset from main's), then the document itself. */
function DesktopDocumentFrame({
  projectId,
  document,
  place,
  header,
  onScreen,
  editorWorkId,
  focusReview,
  onFocusReview,
}: DocumentHostProps & { onScreen: boolean }) {
  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
      role={place === "main" ? "main" : undefined}
    >
      {header}
      <PaintScope active={onScreen}>
        <PaintHold
          status={t`Opening ${document.name}`}
          className={cn(pageSheetClass(place === "side"), "relative flex min-h-0 flex-1 flex-col")}
        >
          <PaintCapture surface={document.documentId} />
          <DocumentStateSlotProvider>
            <DesktopDocumentChrome
              projectId={projectId}
              document={document}
              place={place}
              editorWorkId={editorWorkId}
              focusReview={focusReview}
              onFocusReview={onFocusReview}
            />
            {document.kind === "viewer" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ContextViewerHost projectId={projectId} document={document} />
              </div>
            ) : (
              <div className="relative min-h-0 flex-1">
                <EditableDocument
                  projectId={projectId}
                  document={document}
                  active={onScreen}
                  loadFocus={place === "main"}
                />
              </div>
            )}
          </DocumentStateSlotProvider>
        </PaintHold>
      </PaintScope>
    </div>
  );
}

function EditableDocument({
  projectId,
  document,
  active,
  loadFocus,
}: {
  projectId: string;
  document: EditableOpenDocument;
  active: boolean;
  loadFocus: boolean;
}) {
  const freeze = useHostFreeze(projectId, document);
  return (
    <ContextDocumentHost
      projectId={projectId}
      document={document}
      active={active}
      readOnly={freeze !== null}
      loadFocus={loadFocus}
    />
  );
}

/**
 * One freeze source on every shell: an archived Work freezes its own files and its drafts'
 * reviews; a trashed chat freezes its drafts' reviews.
 */
function useHostFreeze(projectId: string, tab: OpenDocument) {
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const reviewing = review?.documentId === tab.documentId && review.shown;
  return useDocumentFreeze(projectId, tab, reviewing ? controller.ownerKey : null);
}

/** The document's identity and state, its notices and its review's toast. */
function DesktopDocumentChrome({
  projectId,
  document,
  place,
  editorWorkId,
  focusReview,
  onFocusReview,
}: {
  projectId: string;
  document: OpenDocument;
  place: DocumentPlace;
  editorWorkId: string | null;
  focusReview?: string | null;
  onFocusReview?: (itemKey: string | null) => void;
}) {
  const { controller } = useDraftReview();
  const freeze = useHostFreeze(projectId, document);
  const removal = useContextRemovalCoordinator();
  const openRoute = useOpenContextRoute();
  const draftOnly = useDocumentLiveness(projectId, document) === "draft-only";
  // A chat's Scratch belongs to no Work, so archiving the scope's Work never freezes it. The
  // reviewed file itself may be project-owned, so only its own Work's archive freezes its
  // identity row.
  const fileInWork =
    document.kind !== "new" &&
    isWorkScopedScheme(document.scheme) &&
    document.rootThreadId === undefined;
  const onCommitted = (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => {
    // Main's address follows its own document's rename or move; a side document follows the
    // replica's placement on its own.
    if (place !== "main" || !openRoute) return;
    if (!identityCommitMayNavigate(ownership, document.documentId, documentId)) return;
    const { request, options } = identityCommitRoute(documentId, next);
    void openRoute(request, options).then(
      (settlement) => {
        if (settlement.kind === "failed") reportError(settlement.error);
      },
      (error: unknown) => reportError(error),
    );
  };
  return (
    <>
      <DocumentIdentityBar
        key={document.documentId}
        projectId={projectId}
        editorWorkId={editorWorkId}
        document={document}
        readOnly={Boolean(fileInWork && freeze?.kind === "work")}
        onCloseDraftOnly={draftOnly ? () => removal.writerClose(projectId, document) : undefined}
        focusReview={focusReview}
        onFocusReview={onFocusReview}
        onCommitted={onCommitted}
        onOpenExisting={(scheme, path, owner) => {
          void openRoute?.(
            contextRouteRequest({
              scheme,
              path,
              workId: owner.workId,
              rootThreadId: owner.rootThreadId,
            }),
          );
        }}
      />
      <DocumentPaneChrome
        projectId={projectId}
        document={document}
        freeze={freeze}
        reviewNotices={place === "main"}
      />
      {controller.toast ? (
        <ReviewToast toast={controller.toast} onDismiss={controller.dismissToast} />
      ) : null}
    </>
  );
}

/**
 * The phone's one document. No identity bar: the top bar's breadcrumb names the document, and a
 * refused create or move is said here. An untitled document has no review to wrap it.
 */
function PhoneDocumentFrame({
  projectId,
  document,
  local,
}: {
  projectId: string;
  document: OpenDocument;
  local: boolean;
}) {
  const removal = useContextRemovalCoordinator();
  const draftOnly = useDocumentLiveness(projectId, document) === "draft-only";
  const name = document.name;
  return (
    <PaintHold
      status={name ? t`Opening ${name}` : t`Opening draft`}
      className="paper relative h-full min-h-0"
    >
      <PaintCapture surface={document.documentId} />
      {document.kind === "viewer" ? (
        <ContextViewerHost projectId={projectId} document={document} />
      ) : local ? (
        <div className="flex h-full min-h-0 flex-col">
          <PhoneEditor projectId={projectId} document={document} />
        </div>
      ) : (
        <MobileDocumentReview
          projectId={projectId}
          document={document}
          // A draft-only document has no live version to return to: its review closes it.
          onCloseDraftOnly={draftOnly ? () => removal.writerClose(projectId, document) : undefined}
        >
          <PhoneEditor projectId={projectId} document={document}>
            <PassageNotice documentId={document.documentId} />
          </PhoneEditor>
        </MobileDocumentReview>
      )}
    </PaintHold>
  );
}

function PhoneEditor({
  projectId,
  document,
  children,
}: {
  projectId: string;
  document: EditableOpenDocument;
  children?: ReactNode;
}) {
  const freeze = useHostFreeze(projectId, document);
  const review = useDraftReview().controller.inlineReview;
  return (
    <DocumentStateSlotProvider>
      {/* The version chip lives at the toolbar row's end, as on a desktop; a review, painted or on
          its way, shows its own chip in its header. */}
      {review?.documentId === document.documentId ? null : (
        <DocumentStatePortal>
          <DocumentVersionMenu projectId={projectId} document={document} touch />
        </DocumentStatePortal>
      )}
      {freeze ? (
        <DocumentFreezeNotice
          projectId={projectId}
          freeze={freeze}
          className="shrink-0 px-2 pt-2"
        />
      ) : null}
      <MobileRefusalNotice projectId={projectId} document={document} className="shrink-0 px-4" />
      <LiveDraftNotice projectId={projectId} document={document} className="shrink-0 px-2 pt-2" />
      <UnsentDraftTextNotice
        projectId={projectId}
        documentId={document.documentId}
        className="shrink-0 px-2 pt-2"
      />
      <div className="relative min-h-0 flex-1">
        {children}
        <ContextDocumentHost
          projectId={projectId}
          document={document}
          active
          readOnly={freeze !== null}
          presentation={PHONE_DOCUMENT_PRESENTATION}
        />
      </div>
    </DocumentStateSlotProvider>
  );
}

/** Main while its address has no document to paint: opening, or not found. */
export function MainDocumentStatus({ main }: { main: MainDocument }) {
  const { catalogResolved, addressState, isError, isFetching } = main;
  const opening = addressState === "pending" || (isFetching && !catalogResolved);
  const failed = !opening && (isError || catalogResolved);
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-6 text-center text-sm",
        failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <PaintCapture
        state={opening ? "pending" : failed ? "failed" : "painted"}
        surface={opening ? "opening" : failed ? "error" : "viewer"}
      />
      {opening ? (
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </div>
      ) : failed ? (
        <div className="flex items-center gap-2">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </div>
      ) : null}
    </div>
  );
}
