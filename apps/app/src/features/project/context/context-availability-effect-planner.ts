/** Pure final-state planner for one project's availability command batch. */
import {
  isWorkScopedProjectContextScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import type { ContextTab, ProjectTabsSlice } from "@/client/stores";
import {
  buildWorkingSetRoute,
  reconcileSnapshotContextRoutes,
  workingSetRouteIdentityEquals,
} from "@/client/working-set";
import {
  applyContextRepairIfCurrent,
  type ContextRouteTarget,
  contextRouteMatchesSearch,
  openContextRouteSearch,
  type ProjectSearch,
  transitionProjectSearch,
} from "../routing/project-route";
import type {
  AppliedAvailabilityCommand,
  ContextRemovalProjectSnapshot,
} from "./context-removal-coordinator";
import { planContextRemoval, routeTargetForTab } from "./context-removal-planner";
import {
  beginSelection,
  bindSelection,
  type ContextRouteSelection,
  leaveSelection,
  reduceRepresentedRemoval,
} from "./context-removal-protocol";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

export type ContextAvailabilityLocalBatchPlan = Readonly<{
  projectId: string;
  commands: readonly ProjectDocumentAvailabilityCommand[];
  tabs: readonly ContextTab[];
  selectedTabIdByWork: Readonly<Record<string, string>>;
  selection: ContextRouteSelection;
  admitted: ContextRouteTarget | null;
  removalFence: ContextRemovalProjectSnapshot["removalFence"];
  transitionRevision: number;
  recentRoutes: readonly WorkingSetRoute[];
  routeSearch: ProjectSearch | null;
  generationRecords: readonly (AppliedAvailabilityCommand & { documentId: string })[];
  sessionEffects: readonly {
    commandId: string;
    operation: "revoke-document" | "revoke-access";
    projectId: string;
    documentId: string;
    generation: string;
  }[];
}>;

function documentId(command: ProjectDocumentAvailabilityCommand): string {
  return command.kind === "available" ? command.document.entryId : command.documentId;
}

function sameTarget(left: ContextRouteTarget | null, right: ContextRouteTarget): boolean {
  return left?.scheme === right.scheme && left.path === right.path && left.workId === right.workId;
}

export function planContextAvailabilityBatch(
  input: Readonly<{
    commands: readonly ProjectDocumentAvailabilityCommand[];
    project: ContextRemovalProjectSnapshot;
    tabs: ProjectTabsSlice;
    recentRoutes: readonly WorkingSetRoute[];
    routeSearch: ProjectSearch | null;
    appliedGenerations: ReadonlyMap<string, AppliedAvailabilityCommand>;
  }>,
): ContextAvailabilityLocalBatchPlan {
  const projectId = input.commands[0]?.projectId ?? "";
  let tabs = [...input.tabs.tabs];
  const selectedTabIdByWork = { ...input.tabs.selectedTabIdByWork };
  let selection = input.project.selection;
  let admitted = input.project.admitted;
  let removalFence = input.project.removalFence;
  let transitionRevision = input.project.transitionRevision;
  let recentRoutes = [...input.recentRoutes];
  let routeSearch = input.routeSearch;
  const generationRecords: Array<AppliedAvailabilityCommand & { documentId: string }> = [];
  const sessionEffects: ContextAvailabilityLocalBatchPlan["sessionEffects"][number][] = [];
  const unavailableWorkIds = new Set(
    input.commands.flatMap((command) =>
      command.kind === "authority-revoke" &&
      command.cause === "authority-unavailable" &&
      command.authority.kind === "work"
        ? [command.authority.workId]
        : [],
    ),
  );

  for (const command of input.commands) {
    const id = documentId(command);
    generationRecords.push({
      documentId: id,
      generation: command.generation,
      commandId: command.commandId,
      kind: command.kind,
    });
    if (command.kind === "available") {
      const entry = command.document;
      const scheme = entry.uri.slice(0, entry.uri.indexOf(":")) as ContextTab extends {
        scheme: infer Scheme;
      }
        ? Scheme
        : never;
      const path = `/${entry.path.join("/")}`;
      const targetWorkId = isWorkScopedProjectContextScheme(scheme)
        ? entry.scope.kind === "work"
          ? entry.scope.workId
          : null
        : input.project.activeWorkId;
      const target: ContextRouteTarget = { scheme, path, workId: targetWorkId };
      const priorTargets = tabs.flatMap((tab) =>
        tab.kind !== "new" && tab.documentId === id
          ? [
              {
                scheme: tab.scheme,
                path: tab.path,
                workId: isWorkScopedProjectContextScheme(tab.scheme)
                  ? (tab.workId ?? null)
                  : input.project.activeWorkId,
              } satisfies ContextRouteTarget,
            ]
          : [],
      );
      const selectedWorks = Object.entries(selectedTabIdByWork).flatMap(([workId, selected]) =>
        selected === id ? [workId] : [],
      );
      tabs = tabs.map((tab) => {
        if (tab.kind === "new" || tab.documentId !== id) return tab;
        const common = {
          ...tab,
          scheme,
          path,
          name: entry.name,
          provisionalName: entry.provisionalName,
        };
        if (isWorkScopedProjectContextScheme(scheme)) {
          if (targetWorkId) return { ...common, workId: targetWorkId } as ContextTab;
          const { workId: _oldWork, ...withoutWork } = common;
          return withoutWork as ContextTab;
        }
        const { workId: _oldWork, ...withoutWork } = common;
        return targetWorkId
          ? ({ ...withoutWork, workId: targetWorkId } as ContextTab)
          : withoutWork;
      });
      for (const workId of selectedWorks) delete selectedTabIdByWork[workId];
      if (targetWorkId && selectedWorks.length > 0) selectedTabIdByWork[targetWorkId] = id;
      if (
        selection.status === "bound" &&
        selection.identity.kind === "server" &&
        selection.identity.documentId === id
      ) {
        const previous = selection.locator;
        selection = { ...selection, locator: target };
        admitted = target;
        if (
          routeSearch &&
          contextRouteMatchesSearch(routeSearch, previous, input.project.activeWorkId)
        ) {
          routeSearch = openContextRouteSearch(routeSearch, target);
        }
      } else if (priorTargets.some((prior) => sameTarget(admitted, prior))) {
        admitted = target;
      }
      const replacement = buildWorkingSetRoute(
        id,
        scheme,
        path,
        isWorkScopedProjectContextScheme(scheme) ? targetWorkId : undefined,
      );
      if (replacement) {
        recentRoutes = recentRoutes.map((route) =>
          workingSetRouteIdentityEquals(route, replacement) ? replacement : route,
        );
      }
      continue;
    }

    const intent = {
      cause:
        command.kind === "terminal-remove"
          ? ("catalog-unavailable" as const)
          : ("authority-unavailable" as const),
      documentIds: [id],
    };
    const transition = reduceRepresentedRemoval(
      selection,
      tabs,
      intent,
      command.kind === "terminal-remove",
    );
    selection = transition.selection;
    const selectedTabId = input.project.activeWorkId
      ? (selectedTabIdByWork[input.project.activeWorkId] ?? null)
      : null;
    const removal = planContextRemoval({
      activeWorkId: input.project.activeWorkId,
      tabs,
      selectedTabId,
      admitted,
      route: {
        cleanup: transition.planning.cleanup,
        current: transition.planning.current,
      },
      intent,
    });
    if (removal.outcome.kind !== "noop") tabs = [...removal.outcome.remaining];
    for (const [workId, selected] of Object.entries(selectedTabIdByWork)) {
      if (selected === id) delete selectedTabIdByWork[workId];
    }
    if (input.project.activeWorkId && removal.nextSelectedTabId) {
      selectedTabIdByWork[input.project.activeWorkId] = removal.nextSelectedTabId;
    }
    const exactRecentRoutes = recentRoutes.filter((route) => route.documentId === id);
    const workingSet = {
      ...removal.workingSet,
      removedLocators: [...removal.workingSet.removedLocators, ...exactRecentRoutes],
      survivingOwnedLocators: removal.workingSet.survivingOwnedLocators.filter(
        (route) => route.documentId !== id,
      ),
      promote: removal.workingSet.promote?.documentId === id ? null : removal.workingSet.promote,
    };
    recentRoutes = reconcileSnapshotContextRoutes(
      { recentRoutes, lastThreadId: null },
      workingSet,
    ).recentRoutes;
    admitted = removal.admitted;
    if (removal.outcome.kind !== "noop") {
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
    const repairTarget = removal.routeRepairTarget;
    if (routeSearch && repairTarget && transition.planning.current.kind === "proven-removed") {
      const current = transition.planning.current;
      routeSearch = applyContextRepairIfCurrent(
        {
          expectedSearch: {
            screen: "context",
            work: routeSearch.work,
            scheme: current.locator.scheme,
            path: current.locator.path,
          },
          expectedSelection: {
            kind: "removed-binding",
            revision: current.revision,
            documentId: current.identity.documentId,
          },
          next: repairTarget,
        },
        routeSearch,
      );
    }
    if (repairTarget && transition.planning.current.kind === "proven-removed") {
      if ("kind" in repairTarget) {
        selection = leaveSelection(selection).selection;
      } else {
        const candidate = beginSelection(selection, repairTarget).selection;
        const fallback = tabs.find((tab) =>
          sameTarget(routeTargetForTab(tab, input.project.activeWorkId), repairTarget),
        );
        const bound = fallback
          ? bindSelection(candidate, candidate.revision, {
              kind: fallback.kind === "new" ? "local" : "server",
              documentId: fallback.documentId,
            })
          : null;
        selection = bound?.selection ?? candidate;
      }
    }
    sessionEffects.push({
      commandId: command.commandId,
      operation: command.kind === "terminal-remove" ? "revoke-document" : "revoke-access",
      projectId,
      documentId: id,
      generation: command.generation,
    });
  }

  if (unavailableWorkIds.size > 0) {
    recentRoutes = recentRoutes.filter(
      (route) => route.workId == null || !unavailableWorkIds.has(route.workId),
    );
    for (const workId of unavailableWorkIds) delete selectedTabIdByWork[workId];
    const activeWorkId = input.project.activeWorkId;
    if (activeWorkId && unavailableWorkIds.has(activeWorkId)) {
      if (selection.status !== "none" && selection.locator.workId === activeWorkId) {
        selection = leaveSelection(selection).selection;
      }
      if (admitted?.workId === activeWorkId) admitted = null;
      if (input.routeSearch?.work === activeWorkId && routeSearch) {
        routeSearch = transitionProjectSearch(routeSearch, { kind: "work-collection" });
      }
    }
  }

  return {
    projectId,
    commands: input.commands,
    tabs,
    selectedTabIdByWork,
    selection,
    admitted,
    removalFence,
    transitionRevision,
    recentRoutes,
    routeSearch,
    generationRecords,
    sessionEffects,
  };
}
