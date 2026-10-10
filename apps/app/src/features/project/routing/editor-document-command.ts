/** Document commands normalize preparation failures and install tabs before any transfer effect. */
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import { routeTargetForTab } from "../context/context-removal-planner";
import { contextTabMatchesRoute } from "../context/context-tab-identity";
import { resolveLaunchLocator } from "./launch-locator";
import {
  canonicalDocumentPath,
  projectAddressMatchesContextTarget,
} from "./local-document-address";
import type { OpenContextRoute } from "./ProjectNavigationContext";
import type { ProjectAddress, ProjectDestination } from "./project-address";
import { workSelectionFor } from "./project-address-resolution";
import { resolveLocalDocumentSelection } from "./project-local-selection";
import type { createProjectNavigation } from "./project-navigation";
import type { ContextRouteRequest } from "./project-route";

type Navigation = ReturnType<typeof createProjectNavigation>;
export type EditorCommandSnapshot = {
  navigation: Navigation | null;
  address: ProjectAddress;
  editorWorkId: string | null;
  noWorkId: string | null;
  addressDocumentId?: string;
  manuscriptCatalog: Parameters<typeof resolveLaunchLocator>[0]["catalog"];
};
export function createEditorDocumentCommand({
  projectId,
  accountId,
  read,
  lookup,
  admitDraftReview,
}: {
  projectId: string;
  accountId: string;
  read: () => EditorCommandSnapshot;
  lookup: Parameters<typeof resolveLaunchLocator>[0]["lookup"];
  admitDraftReview: (tab: Extract<ContextTab, { kind: "tracked" }>) => void;
}): OpenContextRoute {
  return async (request, options) => {
    const current = read();
    if (!current.navigation || options?.isCurrent?.() === false) return { kind: "superseded" };
    const navigation = current.navigation;
    const ticket = navigation.capture();
    try {
      const resolvedWorkId = request.workId ?? current.editorWorkId;
      const requested = { ...request, workId: resolvedWorkId ?? undefined };
      // Identity decides sameness once the address has resolved; the path is
      // only the fallback before that.
      const sameDocument = projectAddressMatchesContextTarget(
        current.address,
        requested,
        current.noWorkId,
        current.addressDocumentId,
        current.editorWorkId,
      );
      // A review launch carries the locator its draft row captured, which a rename or a
      // reused path can have outdated. Identity decides where that document is now.
      let target: ContextRouteRequest = requested;
      if (options?.replaceIfSameDocument === true) {
        target = await resolveLaunchLocator({
          requested,
          tabs: getContextTabs(projectId).tabs,
          addressed: current.address.destination,
          addressNamesIt: sameDocument,
          draftOnly: options.tab?.kind === "tracked" && options.tab.draftOnly === true,
          catalog: current.manuscriptCatalog,
          lookup,
        });
        if (options.isCurrent?.() === false) return { kind: "superseded" };
      }
      const preparedTab = options?.tab ? tabAtLocator(options.tab, target) : undefined;
      // Re-opening the document the address names (a rename or move following
      // its own placement, a review re-launch) keeps the review the address
      // carries; any other document starts without one.
      const next = prepareEditorDestination(
        { projectId, accountId, address: current.address, noWorkId: current.noWorkId },
        target,
        preparedTab,
        options?.draftId ?? (sameDocument ? current.address.draftId : undefined),
      );
      const tab = next.tab;
      if (!navigation.isCurrent(ticket)) return { kind: "superseded" };
      const commit = () => {
        let selected = tab;
        if (preparedTab) {
          const installed = useContextTabsStore.getState().openTab(projectId, preparedTab);
          if (installed.kind !== "opened") throw new Error("Editor tab could not be opened");
          if (installed.tab.kind === "tracked") admitDraftReview(installed.tab);
          selected = installed.tab;
        }
        if (selected && resolvedWorkId)
          void useContextTabsStore
            .getState()
            .selectTab(
              projectId,
              selected.kind !== "new" && isWorkScopedProjectContextScheme(selected.scheme)
                ? routeTargetForTab(selected, resolvedWorkId).workId
                : resolvedWorkId,
              selected.documentId,
            );
      };
      if (
        options?.replace === undefined &&
        options?.replaceIfSameDocument === true &&
        sameDocument
      ) {
        const result = await navigation.replaceIfCurrent(ticket, next.address);
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
        next.address,
        { replace: options?.replace ?? false, state: next.state },
        {
          isCurrent: () =>
            options?.canCommit?.() !== false &&
            (!tab ||
              getContextTabs(projectId).tabs.some(
                (member) => member.tabInstanceId === tab.tabInstanceId,
              )),
          commit,
          afterCommit: options?.afterCommit,
        },
      );
    } catch (error) {
      return navigation.isCurrent(ticket)
        ? { kind: "failed", error, ticket, stage: "before-acceptance" }
        : { kind: "superseded" };
    }
  };
}

export function prepareEditorDestination(
  {
    projectId,
    accountId,
    address,
    noWorkId,
  }: {
    projectId: string;
    accountId: string;
    address: ProjectAddress;
    noWorkId: string | null;
  },
  target: ContextRouteRequest,
  preparedTab?: ContextTab,
  draftId?: string,
) {
  let state: Record<string, unknown> | undefined;
  const workspace = getContextTabs(projectId);
  const resolvedWorkId = target.workId;
  const documentId =
    target.documentId ??
    (target.path === "" && resolvedWorkId
      ? workspace.selectedTabIdByWork[resolvedWorkId]
      : undefined);
  const tab = documentId
    ? workspace.tabs.find((tab) => tab.documentId === documentId)
    : resolvedWorkId
      ? workspace.tabs.find((tab) =>
          contextTabMatchesRoute(tab, { ...target, workId: resolvedWorkId }),
        )
      : undefined;
  const selected = preparedTab ?? tab;
  // A locally created document keeps its stable selection even when its
  // readable address is reused or its background placement is rejected.
  if (
    target.path === "" ||
    (selected?.kind === "tracked" && selected.origin === "local-resource")
  ) {
    const tabs = preparedTab
      ? [...workspace.tabs.filter((tab) => tab.documentId !== preparedTab.documentId), preparedTab]
      : workspace.tabs;
    if (
      !selected?.resourceHandle ||
      (selected.kind !== "new" &&
        !(selected.kind === "tracked" && selected.origin === "local-resource"))
    )
      throw new Error("Local document is unavailable");
    const pointer = {
      version: 2,
      accountId: accountId,
      projectId,
      resourceHandle: selected.resourceHandle,
    };
    // Pointer identity is ready now; Editor Work membership waits for resolution.
    const resolved = resolvedWorkId
      ? resolveLocalDocumentSelection({
          pointer,
          accountId: accountId,
          projectId,
          workId: routeTargetForTab(selected, resolvedWorkId).workId,
          hydrated: true,
          tabs,
        })
      : null;
    if (resolved && resolved.kind !== "resolved") throw new Error("Local document is unavailable");
    state = { meridianProjectSelection: pointer };
  }
  const destination: ProjectDestination = target.path
    ? { kind: "document", scheme: target.scheme, path: canonicalDocumentPath(target.path) }
    : { kind: "editor" };
  // A chat's Scratch names its lineage and leaves the Editor's own Work to the Editor.
  const { lineage: _previousLineage, ...previous } = address;
  return {
    tab,
    address: {
      ...previous,
      destination,
      work: target.rootThreadId
        ? { kind: "absent" }
        : workSelectionFor(destination, target.workId, noWorkId),
      ...(target.rootThreadId ? { lineage: parseRequestId(target.rootThreadId) } : {}),
      draftId,
    } as ProjectAddress,
    state,
  };
}
/** A prepared tab states the locator the route will use, not the one it was built from. */
function tabAtLocator(tab: ContextTab, locator: ContextRouteRequest): ContextTab {
  if (tab.kind === "new" || (tab.scheme === locator.scheme && tab.path === locator.path))
    return tab;
  return {
    ...tab,
    scheme: locator.scheme,
    path: locator.path,
    name: locator.path.slice(locator.path.lastIndexOf("/") + 1),
  };
}
