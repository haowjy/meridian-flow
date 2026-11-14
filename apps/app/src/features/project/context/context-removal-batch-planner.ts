/** Pure final-state planner for one project's batch of documents the list says are gone. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import type { OpenDocument } from "@/client/stores";
import { reconcileSnapshotContextRoutes } from "@/client/working-set";
import type { ContextRouteRequest } from "../routing/project-route";
import type { ContextRemovalProjectSnapshot } from "./context-removal-coordinator";
import { planContextRemoval } from "./context-removal-planner";
import { type ContextRouteSelection, reduceRepresentedRemoval } from "./context-removal-protocol";

export type ContextRemovalBatchPlan = Readonly<{
  tabs: readonly OpenDocument[];
  selection: ContextRouteSelection;
  admitted: ContextRouteRequest | null;
  removalFence: ContextRemovalProjectSnapshot["removalFence"];
  transitionRevision: number;
  recentRoutes: readonly WorkingSetRoute[];
}>;

export function planContextRemovalBatch(
  input: Readonly<{
    documentIds: readonly string[];
    project: ContextRemovalProjectSnapshot;
    /** What the views present (`PresentedDocuments`). */
    tabs: readonly OpenDocument[];
    /** The document main presents, if any. */
    mainDocumentId: string | null;
    recentRoutes: readonly WorkingSetRoute[];
    /** Documents a draft keeps on screen: their views keep them when live loses them. */
    held?: ReadonlySet<string>;
  }>,
): ContextRemovalBatchPlan {
  let tabs = [...input.tabs];
  let selection = input.project.selection;
  let admitted = input.project.admitted;
  let removalFence = input.project.removalFence;
  let transitionRevision = input.project.transitionRevision;
  let recentRoutes = [...input.recentRoutes];

  for (const id of input.documentIds) {
    const intent = { cause: "catalog-unavailable" as const, documentIds: [id], held: input.held };
    const transition = reduceRepresentedRemoval(selection, tabs, intent, true);
    selection = transition.selection;
    const removal = planContextRemoval({
      activeWorkId: input.project.activeWorkId,
      tabs,
      selectedTabId: input.project.activeWorkId ? input.mainDocumentId : null,
      admitted,
      route: { cleanup: transition.planning.cleanup, current: transition.planning.current },
      intent,
    });
    if (removal.outcome.kind !== "noop") tabs = [...removal.outcome.remaining];
    const exactRecentRoutes = recentRoutes.filter((route) => route.documentId === id);
    const workingSet = {
      ...removal.workingSet,
      removedLocators: [...removal.workingSet.removedLocators, ...exactRecentRoutes],
      survivingOwnedLocators: removal.workingSet.survivingOwnedLocators.filter(
        (route) => route.documentId !== id,
      ),
      promote: removal.workingSet.promote?.documentId === id ? null : removal.workingSet.promote,
    };
    recentRoutes = reconcileSnapshotContextRoutes({ recentRoutes }, workingSet).recentRoutes;
    admitted = removal.admitted;
    if (removal.outcome.kind === "noop") continue;
    transitionRevision += 1;
    const current = transition.planning.current;
    const routedContinuity =
      current.kind !== "none" && removal.outcome.routedDocumentRemoved ? current : null;
    removalFence = {
      selectionRevision: routedContinuity
        ? routedContinuity.revision
        : (removalFence?.selectionRevision ?? selection.revision),
      transitionRevision,
      locator: routedContinuity ? routedContinuity.locator : (removalFence?.locator ?? null),
      removedDocumentIds: [...new Set([...(removalFence?.removedDocumentIds ?? []), id])],
    };
  }

  return { tabs, selection, admitted, removalFence, transitionRevision, recentRoutes };
}
