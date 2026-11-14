import { type DraftOwnerKey, draftOwnerKey } from "@meridian/contracts/branches";
import { readDocumentView } from "@/client/project-shell/document-views";
import { isEditorOpenDocument, type OpenDocument } from "@/client/stores";
import { armEditorFocus } from "@/features/editor/focus-on-open";
import type { RouteBindingProof } from "../context/context-removal-protocol";
import { openDocumentMatchesRoute } from "../context/open-document-identity";
import { addressReviewOwner } from "./document-address-review";
import { resolveLaunchLocator } from "./launch-locator";
import {
  canonicalDocumentPath,
  projectAddressMatchesContextTarget,
} from "./local-document-address";
import type { OpenContextRoute } from "./ProjectNavigationContext";
import { type ProjectAddress, type ProjectDestination, scratchOwnerKey } from "./project-address";
import type { createProjectNavigation } from "./project-navigation";
import { type ContextRouteRequest, contextRouteRequest } from "./project-route";

type Navigation = ReturnType<typeof createProjectNavigation>;
export type EditorCommandSnapshot = {
  navigation: Navigation | null;
  address: ProjectAddress;
  editorWorkId: string | null;
  addressDocumentId?: string;
  documentTree: Parameters<typeof resolveLaunchLocator>[0]["tree"];
};
/**
 * Opening a document in main is one navigation: the address names the document, and main's host
 * follows it. Nothing is installed or selected.
 */
export function createEditorDocumentCommand({
  projectId,
  accountId,
  read,
  presented,
  isDraftOnly,
  admitDraftReview,
  enterRoute,
}: {
  projectId: string;
  accountId: string;
  read: () => EditorCommandSnapshot;
  /** What the views present now (`PresentedDocuments`): a renamed document's current locator. */
  presented: () => readonly OpenDocument[];
  /** Some host presents this document draft-only (`DraftOnlyPresentations`). */
  isDraftOnly: (documentId: string) => boolean;
  admitDraftReview: (tab: Extract<OpenDocument, { kind: "tracked" }>) => void;
  /** Binds the route about to be shown to the document the navigation named. */
  enterRoute: (locator: ContextRouteRequest, documentId: string, by: RouteBindingProof) => void;
}): OpenContextRoute {
  return async (request, options) => {
    const current = read();
    if (!current.navigation || options?.isCurrent?.() === false) return { kind: "superseded" };
    const navigation = current.navigation;
    const ticket = navigation.capture();
    try {
      const scope = current.editorWorkId;
      const requested = routeTargetOwner(request, scope);
      // Identity decides sameness once the address has resolved; the path is
      // only the fallback before that.
      const sameDocument = projectAddressMatchesContextTarget(
        current.address,
        requested,
        current.addressDocumentId,
      );
      // A review launch carries the locator its draft row captured, which a rename or a
      // reused path can have outdated. Identity decides where that document is now.
      let target: ContextRouteRequest = requested;
      if (options?.replaceIfSameDocument === true) {
        target = resolveLaunchLocator({
          requested,
          tabs: presented(),
          addressed: current.address.destination,
          addressNamesIt: sameDocument,
          draftOnly:
            options.draftOnly === true ||
            (options.document !== undefined && isDraftOnly(options.document.documentId)),
          tree: current.documentTree,
          selected: !!options.itemKey && scope !== null,
        });
        if (options.isCurrent?.() === false) return { kind: "superseded" };
      }
      const preparedTab = options?.document ? tabAtLocator(options.document, target) : undefined;
      // Re-opening the document the address names (a rename or move following
      // its own placement, a review re-launch) keeps the review the address
      // carries; any other document starts without one.
      // A draft-only document has no live version: its draft is the only destination that
      // resolves, so every re-select or restore of it (a repair's fallback, a tab click) carries
      // the draft its view pins.
      const draftOnlyPin = draftOnlyDocumentPin(
        options?.document ? [options.document] : presented(),
        requested,
        isDraftOnly,
        (documentId) => readDocumentView(accountId, projectId, documentId).pin,
      );
      const reviewOwner =
        options?.reviewOwner ??
        draftOnlyPin?.ownerKey ??
        (sameDocument ? (addressReviewOwner(current.address, scope) ?? undefined) : undefined);
      const itemKey =
        options?.itemKey ??
        draftOnlyPin?.itemKey ??
        (sameDocument ? current.address.itemKey : undefined);
      const next = prepareEditorDestination(
        { address: current.address, scope },
        target,
        itemKey,
        reviewOwner,
        options?.changeId ??
          (sameDocument && (!itemKey || itemKey === current.address.itemKey)
            ? current.address.changeId
            : undefined),
      );
      if (!navigation.isCurrent(ticket)) return { kind: "superseded" };
      const commit = () => {
        if (preparedTab?.kind === "tracked" && itemKey) admitDraftReview(preparedTab);
        const focused = target.documentId ?? preparedTab?.documentId;
        if (options?.focus && focused) armEditorFocus(focused);
        // The writer opened this document: the route is its own from the first frame, whatever
        // another document holds at its cached path. A pasted or reloaded URL names none.
        if (target.documentId && target.path && scope)
          enterRoute(
            contextRouteRequest({ ...target, path: `/${canonicalDocumentPath(target.path)}` }),
            target.documentId,
            // An address that carries an item is a review: the item owns its path.
            itemKey ? "review" : "navigation",
          );
      };
      if (
        options?.replace === undefined &&
        options?.replaceIfSameDocument === true &&
        sameDocument
      ) {
        // The address already carries this review: the owner that settles its path may have
        // moved the URL since this command read it, and writing the stale path back would flip it.
        const carriesReview = !!itemKey && itemKey === current.address.itemKey;
        const result = carriesReview
          ? { kind: "replaced" as const }
          : await navigation.replaceIfCurrent(ticket, next);
        if (result.kind !== "replaced")
          return result.kind === "failed"
            ? { ...result, stage: "before-acceptance" }
            : { kind: "superseded" };
        try {
          commit();
          options?.afterCommit?.();
          return { kind: "applied" };
        } catch (error) {
          return { kind: "failed", error, ticket: navigation.capture(), stage: "workspace-commit" };
        }
      }
      return navigation.transition(
        next,
        { replace: options?.replace ?? false },
        {
          isCurrent: () => options?.canCommit?.() !== false,
          commit,
          afterCommit: () => options?.afterCommit?.(),
        },
      );
    } catch (error) {
      return navigation.isCurrent(ticket)
        ? { kind: "failed", error, ticket, stage: "before-acceptance" }
        : { kind: "superseded" };
    }
  };
}

/** A bare Scratch request takes the scope's Work as its owner. */
function routeTargetOwner(request: ContextRouteRequest, scope: string | null): ContextRouteRequest {
  if (request.scheme !== "scratch" || request.workId || request.rootThreadId || !scope)
    return request;
  return contextRouteRequest({ ...request, workId: scope });
}

export function prepareEditorDestination(
  {
    address,
    scope,
  }: {
    address: ProjectAddress;
    /** The Work scope; null while the Works list has not resolved. */
    scope: string | null;
  },
  target: ContextRouteRequest,
  itemKey?: string,
  reviewOwner?: string,
  changeId?: string,
) {
  const destination: ProjectDestination = target.path
    ? { kind: "document", scheme: target.scheme, path: canonicalDocumentPath(target.path) }
    : { kind: "editor" };
  // Only a Scratch document and a draft item put an owner in the address; the scope never is one.
  const workOwner = scope ? draftOwnerKey({ kind: "work", workId: scope }) : undefined;
  const scratchOwner =
    target.scheme === "scratch" && (target.workId || target.rootThreadId)
      ? scratchOwnerKey({ workId: target.workId ?? "", rootThreadId: target.rootThreadId })
      : undefined;
  const owner = !target.path
    ? undefined
    : itemKey
      ? ((reviewOwner as DraftOwnerKey | undefined) ?? scratchOwner ?? workOwner)
      : scratchOwner;
  const { owner: _previousOwner, ...previous } = address;
  return {
    ...previous,
    destination,
    ...(owner ? { owner } : {}),
    itemKey: owner ? itemKey : undefined,
    changeId: owner && itemKey ? changeId : undefined,
  } as ProjectAddress;
}
/** The draft a request's draft-only document is shown on, if the request names one. */
function draftOnlyDocumentPin(
  tabs: readonly OpenDocument[],
  request: ContextRouteRequest,
  isDraftOnly: (documentId: string) => boolean,
  pinOf: (documentId: string) => ReturnType<typeof readDocumentView>["pin"],
) {
  const tab = tabs
    .filter(isEditorOpenDocument)
    .find(
      (tab) =>
        tab.kind !== "new" &&
        (request.documentId === undefined || tab.documentId === request.documentId) &&
        openDocumentMatchesRoute(tab, request) &&
        isDraftOnly(tab.documentId),
    );
  return tab ? pinOf(tab.documentId) : undefined;
}

/** A prepared tab states the locator the route will use, not the one it was built from. */
function tabAtLocator(tab: OpenDocument, locator: ContextRouteRequest): OpenDocument {
  if (tab.kind === "new" || (tab.scheme === locator.scheme && tab.path === locator.path))
    return tab;
  return {
    ...tab,
    scheme: locator.scheme,
    path: locator.path,
    name: locator.path.slice(locator.path.lastIndexOf("/") + 1),
  };
}
