import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { Work } from "@meridian/contracts/works";
import { AlertCircle, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useOptionalPresentedDocuments } from "@/client/account/account-composition";
import { placeTab } from "@/client/project-shell/open-document-from-file";
import type { MountedPlace } from "@/client/project-shell/presented-documents";
import { contextRouteRequest } from "@/client/project-shell/project-route";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import { useWorkState } from "@/client/query/work-state";
import type { OpenDocument } from "@/client/stores";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import { AgentFileState } from "@/features/agents/AgentFileState";
import { ReviewEscapeScope } from "@/features/draft-review/ReviewEscapeScope";
import { useReviewMode } from "@/features/draft-review/review-mode";
import { DocumentVersionMenu } from "@/features/editor/DocumentVersionMenu";
import {
  DocumentStatePortal,
  DocumentStateSlotProvider,
} from "@/features/editor/document-state-slot";
import { MainSurface } from "@/features/editor/MainSurface";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { cn } from "@/lib/utils";
import { DocumentReviewProvider } from "../DocumentReview";
import { MobileDocumentReview } from "../mobile/MobileDocumentReview";
import { PanePlaceContext } from "../pane-place";
import { useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { pageSheetClass } from "../shell/tab-chip";
import type { MainDocument } from "../views";
import { EndedWorkNotice } from "../work/EndedWorkNotice";
import { ContextDocumentHost, type EditableOpenDocument } from "./ContextDocumentHost";
import { ContextViewerHost } from "./ContextViewerHost";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { DocumentPaneChrome } from "./DocumentPaneChrome";
import { PHONE_DOCUMENT_PRESENTATION } from "./document-presentation";
import { recentOpening } from "./recent-opening";
import { useDocumentLiveness } from "./use-draft-only-presentation";
import {
  type IdentityCommitOwnership,
  type IdentityCommitted,
  identityCommitMayNavigate,
  identityCommitRoute,
} from "./use-identity-commit";
import { useRecordOpenedDocument } from "./use-record-opened-document";

export type DocumentPlace = MountedPlace;

export type DocumentHostProps = {
  projectId: string;
  document: OpenDocument;
  place: DocumentPlace;
  visible: boolean;
  main?: MainDocument;
  presentation: "desktop" | "phone";
  header?: ReactNode;
  editorWorkId: string | null;
};

export function DocumentHost(props: DocumentHostProps) {
  const { projectId, place } = props;
  const tab = useCurrentDescriptor(projectId, props.document, place === "main");
  const onScreen = place !== "kept" && props.visible;
  useMountDocument(projectId, tab, place);
  return (
    <PanePlaceContext.Provider value={place === "side" ? "side" : "main"}>
      <DocumentReviewProvider projectId={projectId} document={tab} showing={onScreen}>
        <ReviewEscapeScope>
          {place === "main" && props.main ? (
            <MainDocumentBinding projectId={projectId} document={tab} />
          ) : null}
          {props.presentation === "phone" ? (
            place === "main" ? (
              <PhoneDocumentFrame projectId={projectId} document={tab} />
            ) : (
              <div className="flex h-full min-h-0 flex-col">
                {props.header}
                <div className="min-h-0 flex-1">
                  <PhoneDocumentFrame projectId={projectId} document={tab} />
                </div>
              </div>
            )
          ) : (
            <DesktopDocumentFrame {...props} document={tab} onScreen={onScreen} />
          )}
        </ReviewEscapeScope>
      </DocumentReviewProvider>
    </PanePlaceContext.Provider>
  );
}

function useCurrentDescriptor(projectId: string, tab: OpenDocument, main: boolean): OpenDocument {
  const trees = useProjectTrees(projectId);
  if (main) return tab;
  const found = trees.find(tab.documentId);
  const placed = placeTab(
    found && { scheme: found.source.scheme, file: found.file, owner: ownerOfSource(found.source) },
    trees.isComplete,
  );
  return placed.kind === "projected" ? placed.document : tab;
}

function useMountDocument(projectId: string, tab: OpenDocument, place: DocumentPlace) {
  const presented = useOptionalPresentedDocuments();
  const [token] = useState(() => crypto.randomUUID());
  useLayoutEffect(() => {
    presented?.mount(token, projectId, tab, place);
  }, [presented, token, projectId, tab, place]);
  useLayoutEffect(() => () => presented?.unmount(token), [presented, token]);
}

function MainDocumentBinding({
  projectId,
  document,
}: {
  projectId: string;
  document: OpenDocument;
}) {
  const liveness = useDocumentLiveness(projectId, document);

  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (liveness !== "live") {
      recorded.current = null;
      return;
    }
    if (recorded.current === document.documentId) return;
    const opening = recentOpening(projectId, document, new Date().toISOString());
    if (!opening) return;
    recorded.current = document.documentId;
    record(opening);
  }, [liveness, document, projectId, record]);
  return null;
}

function DesktopDocumentFrame({
  projectId,
  document,
  place,
  header,
  onScreen,
  editorWorkId,
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
            />
            {document.kind === "viewer" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ContextViewerHost
                  projectId={projectId}
                  document={document}
                  inMain={place === "main"}
                />
              </div>
            ) : (
              <div className="relative min-h-0 flex-1">
                <EditableDocument
                  projectId={projectId}
                  document={document}
                  active={onScreen}
                  inMain={place === "main"}
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
  inMain,
}: {
  projectId: string;
  document: EditableOpenDocument;
  active: boolean;
  inMain: boolean;
}) {
  const freeze = useEndedWork(projectId, document);
  return (
    <ContextDocumentHost
      projectId={projectId}
      document={document}
      active={active}
      readOnly={freeze !== null}
      inMain={inMain}
    />
  );
}

function DesktopDocumentChrome({
  projectId,
  document,
  place,
  editorWorkId,
}: {
  projectId: string;
  document: OpenDocument;
  place: DocumentPlace;
  editorWorkId: string | null;
}) {
  const freeze = useEndedWork(projectId, document);
  const openRoute = useOpenContextRoute();
  const fileInWork =
    document.kind !== "new" &&
    isWorkScopedScheme(document.scheme) &&
    document.rootThreadId === undefined;
  const onCommitted = (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => {
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
        readOnly={Boolean(fileInWork && freeze)}
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
      <DocumentPaneChrome projectId={projectId} document={document} freeze={freeze} />
    </>
  );
}

function PhoneDocumentFrame({
  projectId,
  document,
}: {
  projectId: string;
  document: OpenDocument;
}) {
  const name = document.name;
  return (
    <PaintHold
      status={name ? t`Opening ${name}` : t`Opening document`}
      className="paper relative h-full min-h-0"
    >
      <PaintCapture surface={document.documentId} />
      {document.kind === "viewer" ? (
        <ContextViewerHost projectId={projectId} document={document} />
      ) : (
        <MobileDocumentReview projectId={projectId} document={document}>
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
  const freeze = useEndedWork(projectId, document);
  const review = useReviewMode();
  return (
    <DocumentStateSlotProvider>
      {review?.documentId === document.documentId ? null : (
        <DocumentStatePortal>
          <AgentFileState projectId={projectId} document={document} touch />
          <DocumentVersionMenu projectId={projectId} document={document} touch />
        </DocumentStatePortal>
      )}
      {freeze ? (
        <EndedWorkNotice projectId={projectId} work={freeze} className="shrink-0 px-2 pt-2" />
      ) : null}
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

export function MainDocumentStatus({ main }: { main: MainDocument }) {
  const { catalogResolved, addressState, isError } = main;
  const opening = addressState === "pending";
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
        <MainSurface joined className="flex items-center gap-2">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </MainSurface>
      ) : null}
    </div>
  );
}

function useEndedWork(projectId: string, document: OpenDocument): Work | null {
  const state = useWorkState(
    projectId,
    document.kind !== "new" && isWorkScopedScheme(document.scheme) ? document.workId : null,
  );
  return state.kind === "ended" ? state.work : null;
}
