/**
 * The two ways to open a document on a draft. `openDraft` opens the plain draft; `openReview` opens
 * it in Review changes, against Live unless the caller names another reference, at the clicked
 * change. Every launcher declares which, by how the writer arrived (design §6, item 5). Both set
 * the document's view to the draft and open it in the pane `place` picks: in main the route command
 * writes the address (a review pushes); beside, `place` shows it. Latest launch wins.
 */

import { type DocumentId, type DraftId, draftItemKey } from "@meridian/contracts";
import type { EventRecord } from "@meridian/contracts/observability";
import { createContext, type ReactNode, useCallback, useContext, useRef } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { claimDocumentTarget, whenEditorMounted } from "@/core/editor/reading-position-navigation";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDocumentRef } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { escapeCssIdent } from "@/lib/css-selector";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";
import { type OpenDocumentOutcome, useOpenProjectDocument } from "./context/open-project-document";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import type { ReviewTarget } from "./routing/project-address";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalPlaceHere } from "./side/SideView";
import { useShellTreeVersion } from "./tree-version";

export type ItemLaunchTarget = {
  draftId: string;
  documentId: string;
  itemKey: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
  /** Live doesn't hold the document: the draft created it, or live deleted it. */
  draftOnly?: boolean;
  /** Review changes on, against this; omission opens the plain draft. */
  review?: ReviewTarget;
  /** The change Review changes opens at. */
  focus?: ReviewFocus;
  /** The writer just made the document: its text takes the caret, as one made on Live does. */
  made?: true;
  /** Replace the history entry: the stepper crossing chapters within Review changes. */
  replace?: true;
};

type EditorReviewCommand = (target: ItemLaunchTarget) => Promise<void>;

function reportRouteSettlement(
  projectId: string,
  target: ItemLaunchTarget,
  kind: "applied" | "cancelled" | "superseded" | "failed",
  attempt: number,
): void {
  if (!DEBUG_FEATURE_ALLOWED) return;
  const event: EventRecord = {
    timestamp: new Date().toISOString(),
    level: kind === "failed" ? "error" : kind === "applied" ? "info" : "warn",
    source: "project.review",
    name: "editor_review.route_settlement",
    sensitivity: "safe",
    correlation: { projectId },
    payload: {
      kind,
      attempt,
      draftId: target.draftId,
      documentId: target.documentId,
      itemKey: target.itemKey,
    },
  };
  appendTraceEvent(event);
}

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);

export function ReviewLaunchProvider({
  projectId,
  openContextRoute,
  children,
}: {
  projectId: string;
  openContextRoute: OpenContextRoute;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const sequence = useRef(0);
  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      // The pin is written once the document is open, so a cancelled or failed navigation leaves
      // no other host holding this document switched to the draft.
      const pin = () =>
        setDocumentView(accountId, projectId, target.documentId, {
          pin: { draftId: target.draftId, itemKey: target.itemKey },
        });
      const tab = openDocumentFromDraftGroup(target);
      const launch = ++sequence.current;
      // A launch is an arrival: the document's editor opens at the change, not at the place the
      // writer last left. The claim holds until the editor has mounted.
      const releaseTarget = claimDocumentTarget(target.documentId);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await openContextRoute(
            contextRouteRequest({
              ...target.contextLocation,
              documentId: target.documentId,
            }),
            {
              ...(target.replace ? { replace: true } : { replaceIfSameDocument: true }),
              document: tab ?? undefined,
              draftOnly: target.draftOnly,
              itemKey: target.itemKey,
              review: target.review,
              changeId: target.review ? target.focus?.id : undefined,
              ...(target.made ? { focus: true as const } : {}),
              canCommit: () => sequence.current === launch,
              afterCommit: pin,
            },
          );
          reportRouteSettlement(projectId, target, result.kind, attempt + 1);
          if (result.kind === "failed") throw result.error;
          if (result.kind === "applied") {
            await whenEditorMounted(target.documentId, AbortSignal.timeout(5_000));
            return;
          }
          if (result.kind !== "superseded" || sequence.current !== launch) return;
        }
      } finally {
        releaseTarget();
      }
      throw new Error("Editor review navigation did not settle after retry");
    },
    [openContextRoute, projectId, accountId],
  );

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      {children}
    </EditorReviewCommandContext.Provider>
  );
}

/** Null where no review owner is mounted: a surface that only sometimes launches a review (a link to a draft). */
function useOptionalOpenEditorReview(): EditorReviewCommand | null {
  return useContext(EditorReviewCommandContext);
}

const committed = (documentId: string): OpenDocumentOutcome => ({ kind: "committed", documentId });

/** Opens a draft item's document, on its plain page or in Review changes, in the pane `place` picks. */
function useOpenItem(): (target: ItemLaunchTarget) => Promise<OpenDocumentOutcome> {
  const openEditorReview = useOptionalOpenEditorReview();
  const place = useOptionalPlaceHere();
  const shell = useShellTreeVersion();
  // A draft of the toggle's Work is that Work's version of the page: the toggle goes to Draft.
  const showsWork = shell?.show;
  const workOwner = shell?.draftId;
  return useCallback(
    (target) => {
      if (showsWork && target.draftId === workOwner) showsWork("draft");
      const draft = {
        draftId: target.draftId,
        itemKey: target.itemKey,
        ...(target.review
          ? { review: target.review, ...(target.focus ? { changeId: target.focus.id } : {}) }
          : {}),
      };
      if (place?.({ kind: "document", documentId: target.documentId }, draft) === "side")
        return Promise.resolve(committed(target.documentId));
      if (!openEditorReview)
        throw new Error("Opening a draft requires the project review handoff owner");
      return openEditorReview(target).then(
        () => committed(target.documentId),
        (error): OpenDocumentOutcome => {
          console.error("[editor-review] launch failed", error);
          return { kind: "cancelled" };
        },
      );
    },
    [place, openEditorReview, showsWork, workOwner],
  );
}

function fileTarget(row: ReviewFileTarget, draftId: string): ItemLaunchTarget | null {
  // An item with no address yet (still being written) has nothing to open.
  if (!row.contextLocation) return null;
  return {
    draftId,
    documentId: row.documentId,
    itemKey: row.item.itemKey,
    contextLocation: row.contextLocation,
    documentName: row.documentName ?? undefined,
    draftOnly: row.draftOnly,
  };
}

export function useItemLauncher() {
  const open = useOpenItem();
  /** The plain draft: the draft chip, the toggle, a tree row, a created document, a link. */
  const openDraft = useCallback(
    (target: ItemLaunchTarget) => {
      void open({ ...target, review: undefined, focus: undefined });
    },
    [open],
  );
  /** Review changes: `Review N changes`, a Changes or dock row, a turn's edited chapter. */
  const openReview = useCallback(
    (target: ItemLaunchTarget) => {
      void open({ ...target, review: target.review ?? "live" }).then((outcome) => {
        if (outcome.kind === "committed") focusReviewControls(target.documentId);
      });
    },
    [open],
  );
  const openDraftFile = useCallback(
    (row: ReviewFileTarget, draftId: string) => {
      const target = fileTarget(row, draftId);
      if (target) openDraft(target);
    },
    [openDraft],
  );
  const openReviewFile = useCallback(
    (row: ReviewFileTarget, draftId: string, focus?: ReviewFocus) => {
      const target = fileTarget(row, draftId);
      if (target) openReview({ ...target, ...(focus ? { focus } : {}) });
    },
    [openReview],
  );

  return { openDraft, openReview, openDraftFile, openReviewFile };
}

/** A document the writer just made: where the version it was made in puts it. */
export type CreatedDocument = {
  documentId: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
};

/**
 * Opens a document the writer just made, at once, in the version they made it in. On Live that is
 * `live`. On Draft it is the Work's draft of it: the create names that draft (`createdDraftId`),
 * so the page opens on it before the server has heard of the create, offline too, as a Changes row
 * opens a listed one. `opened` runs once it opens (the phone's drawer closes then, as a row's click
 * closes it).
 */
export function useOpenCreatedDocument(): (
  document: CreatedDocument,
  live: () => Promise<void>,
  opened?: () => void,
) => Promise<void> {
  const shell = useShellTreeVersion();
  const { openDraft } = useItemLauncher();
  const shown = shell?.version.view.draft ?? null;
  return useCallback(
    async (document, live, opened) => {
      if (!shown) return live();
      openDraft({
        draftId: shown,
        documentId: document.documentId,
        itemKey: draftItemKey(shown as DraftId, document.documentId as DocumentId),
        contextLocation: document.contextLocation,
        documentName: document.documentName,
        draftOnly: true,
        made: true,
      });
      opened?.();
    },
    [shown, openDraft],
  );
}

/**
 * Where one followed link goes. `live` is the surface's own opener for a live page, which passes
 * `placeBeside` on to the opener; `workId` is the Work the link names, which a hold beside keeps.
 */
export type LinkPlacement = (
  document: LinkDocumentRef,
  live: (document: LinkDocumentRef, placeBeside?: () => boolean) => Promise<OpenDocumentOutcome>,
  workId?: string | null,
) => Promise<OpenDocumentOutcome>;

/**
 * What a followed link opens: the one rule for links in a chat or a page, a chat's doors and its
 * "Drafted N documents" rows. The pane is `place`'s.
 * - A page only a draft holds (`document.review`) opens on that draft.
 * - A page `draftId` drafted opens on that draft, as the draft strip does.
 * - Any other page opens through `live`. Once the opener knows what it is, a chat's upload opens in
 *   its viewer wherever the link is (no pane holds one), a page in the trash opens in main, and any
 *   other page is placed beside in the link's Work (`placeBeside`) or opens in main.
 */
export function useLinkPlacement(projectId: string | null, draftId: string | null): LinkPlacement {
  const { fileForDocument } = useOwnerDrafts(projectId, draftId);
  const openItem = useOpenItem();
  const place = useOptionalPlaceHere();
  return useCallback(
    (document, live, workId) => {
      if (document.review)
        return openItem({
          documentId: document.documentId,
          ...document.review,
          draftOnly: true,
        });
      if (document.trashed) return live(document);
      const drafted = draftId ? fileForDocument(document.documentId) : null;
      if (draftId && drafted?.contextLocation)
        return openItem({
          draftId,
          documentId: document.documentId,
          itemKey: drafted.item.itemKey,
          contextLocation: drafted.contextLocation,
          documentName: drafted.documentName ?? undefined,
          draftOnly: drafted.draftOnly,
        });
      const placed = {
        kind: "document",
        documentId: document.documentId,
        ...(workId ? { workId } : {}),
      } as const;
      return live(document, place ? () => place(placed) === "side" : undefined);
    },
    [fileForDocument, draftId, openItem, place],
  );
}

/**
 * Opens a document by id where `useLinkPlacement` puts it: a chip or a mention in a chat's
 * message or composer.
 */
export function useOpenPlacedDocument(
  projectId: string | undefined,
): (documentId: string) => Promise<OpenDocumentOutcome> {
  const openDocument = useOpenProjectDocument(projectId);
  const place = useLinkPlacement(projectId ?? null, null);
  return useCallback(
    (documentId) =>
      place({ documentId }, (found, placeBeside) =>
        openDocument({ documentId: found.documentId, placeBeside }),
      ),
    [place, openDocument],
  );
}

/**
 * Opening Review changes moves the focus to its stepper (its Close when there is nothing to
 * step), once the document's bar has mounted.
 */
export function focusReviewControls(documentId: string): void {
  let frames = 30;
  const attempt = () => {
    const bar = document.querySelector<HTMLElement>(
      `[data-review-bar="${escapeCssIdent(documentId)}"]`,
    );
    const target =
      bar?.querySelector<HTMLElement>("[data-review-stepper]") ??
      bar?.querySelector<HTMLElement>(":scope > button:last-of-type");
    if (target) target.focus();
    else if (--frames > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
