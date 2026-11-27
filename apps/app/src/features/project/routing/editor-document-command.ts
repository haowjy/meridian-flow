import { readSegment } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import { armEditorFocus } from "@/features/editor/focus-on-open";
import { resolveLaunchLocator } from "./launch-locator";
import {
  canonicalDocumentPath,
  projectAddressMatchesContextTarget,
} from "./local-document-address";
import { reviewOpenedFromMark } from "./main-review";
import type { OpenContextRoute } from "./ProjectNavigationContext";
import {
  type ProjectAddress,
  type ProjectDestination,
  type ReviewTarget,
  scratchOwnerKey,
} from "./project-address";
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
export function createEditorDocumentCommand({
  read,
  presented,
}: {
  read: () => EditorCommandSnapshot;
  presented: () => readonly OpenDocument[];
}): OpenContextRoute {
  return async (request, options) => {
    const current = read();
    if (!current.navigation || options?.isCurrent?.() === false) return { kind: "superseded" };
    const navigation = current.navigation;
    const ticket = navigation.capture();
    try {
      const scope = current.editorWorkId;
      const requested = routeTargetOwner(request, scope);
      const sameDocument = projectAddressMatchesContextTarget(
        current.address,
        requested,
        current.addressDocumentId,
      );
      let target: ContextRouteRequest = requested;
      if (options?.replaceIfSameDocument === true) {
        target = resolveLaunchLocator({
          requested,
          tabs: presented(),
          addressed: current.address.destination,
          addressNamesIt: sameDocument,
          draftOnly: options.draftOnly === true,
          tree: current.documentTree,
          selected: !!options.itemKey && scope !== null,
        });
        if (options.isCurrent?.() === false) return { kind: "superseded" };
      }
      const preparedTab = options?.document ? tabAtLocator(options.document, target) : undefined;
      const itemKey = options?.itemKey ?? (sameDocument ? current.address.itemKey : undefined);
      // The same document on the same draft keeps its review unless the open names one.
      const keepsReview =
        options?.review === undefined &&
        sameDocument &&
        !!itemKey &&
        itemKey === current.address.itemKey &&
        options?.itemKey === undefined;
      const review = options?.review ?? (keepsReview ? current.address.review : undefined);
      const next = prepareEditorDestination(
        current.address,
        target,
        itemKey,
        review,
        options?.changeId ?? (keepsReview ? current.address.changeId : undefined),
      );
      if (!navigation.isCurrent(ticket)) return { kind: "superseded" };
      const commit = () => {
        const focused = target.documentId ?? preparedTab?.documentId;
        if (options?.focus && focused) armEditorFocus(focused);
      };
      const opensReview = !!next.review && !current.address.review;
      if (
        options?.replace === undefined &&
        options?.replaceIfSameDocument === true &&
        sameDocument &&
        !opensReview
      ) {
        // The address already carries this review: the owner that settles its path may have
        // moved the URL since this command read it, and writing the stale path back would flip it.
        const carriesReview =
          !!itemKey &&
          itemKey === current.address.itemKey &&
          next.review === current.address.review &&
          next.changeId === current.address.changeId;
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
      const replace = options?.replace ?? false;
      // The push records the page it was opened from, so closing goes Back there (`main-review`).
      const state =
        opensReview && !replace && current.addressDocumentId
          ? reviewOpenedFromMark(current.addressDocumentId)
          : undefined;
      return navigation.transition(
        next,
        { replace, ...(state ? { state } : {}) },
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

function routeTargetOwner(request: ContextRouteRequest, scope: string | null): ContextRouteRequest {
  if (request.scheme !== "scratch" || request.workId || request.rootThreadId || !scope)
    return request;
  return contextRouteRequest({ ...request, workId: scope });
}

export function prepareEditorDestination(
  address: ProjectAddress,
  target: ContextRouteRequest,
  itemKey?: string,
  review?: ReviewTarget,
  changeId?: string,
) {
  const destination: ProjectDestination = target.path
    ? { kind: "document", scheme: target.scheme, path: canonicalDocumentPath(target.path) }
    : { kind: "editor" };
  // Only a Scratch document puts an owner in the address; the scope never is one.
  const scratchOwner =
    target.scheme === "scratch" && (target.workId || target.rootThreadId)
      ? scratchOwnerKey({ workId: target.workId ?? "", rootThreadId: target.rootThreadId })
      : undefined;
  const owner = target.path ? scratchOwner : undefined;
  const item = target.path ? itemKey : undefined;
  const reviewing = item ? review : undefined;
  const { owner: _previousOwner, ...previous } = address;
  return {
    ...previous,
    destination,
    ...(owner ? { owner } : {}),
    itemKey: item,
    review: reviewing,
    changeId: reviewing ? changeId : undefined,
  } as ProjectAddress;
}
function tabAtLocator(tab: OpenDocument, locator: ContextRouteRequest): OpenDocument {
  if (tab.kind === "new" || (tab.scheme === locator.scheme && tab.path === locator.path))
    return tab;
  return {
    ...tab,
    scheme: locator.scheme,
    path: locator.path,
    name: readSegment(locator.path.slice(locator.path.lastIndexOf("/") + 1)).name,
  };
}
