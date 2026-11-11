/** Pure final-state planner for one project's availability command batch. */

import { isWorkScopedScheme, parseContextUri } from "@meridian/contracts/context-uri";
import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { type ContextTab, type ProjectTabsSlice, selectedDocumentIdOf } from "@/client/stores";
import {
  buildWorkingSetRoute,
  reconcileSnapshotContextRoutes,
  workingSetRouteIdentityEquals,
} from "@/client/working-set";
import {
  type ContextRouteRequest,
  contextRouteMatchesSearch,
  openContextRouteSearch,
  type ProjectSearch,
  sameContextTarget,
} from "../routing/project-route";
import type {
  AppliedAvailabilityCommand,
  ContextRemovalProjectSnapshot,
} from "./context-removal-coordinator";
import { planContextRemoval, routeTargetForTab } from "./context-removal-planner";
import {
  type ContextRouteSelection,
  leaveSelection,
  reduceRepresentedRemoval,
} from "./context-removal-protocol";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

export type ContextAvailabilityLocalBatchPlan = Readonly<{
  projectId: string;
  commands: readonly ProjectDocumentAvailabilityCommand[];
  tabs: readonly ContextTab[];
  selectedDocumentId: string | null;
  selection: ContextRouteSelection;
  admitted: ContextRouteRequest | null;
  removalFence: ContextRemovalProjectSnapshot["removalFence"];
  transitionRevision: number;
  recentRoutes: readonly WorkingSetRoute[];
  routeSearch: ProjectSearch | null;
  /** The document whose move rewrote `routeSearch`, so the route can tell relocation from replacement. */
  relocatedRouteDocumentId: string | null;
  generationRecords: readonly (AppliedAvailabilityCommand & { documentId: string })[];
  sessionEffects: readonly {
    commandId: string;
    operation: "revoke-document" | "revoke-access";
    projectId: string;
    documentId: string;
    generation: string;
    deletionVersion: string | null;
  }[];
}>;

function documentId(command: ProjectDocumentAvailabilityCommand): string {
  return command.kind === "available" ? command.document.entryId : command.documentId;
}

function sameTarget(left: ContextRouteRequest | null, right: ContextRouteRequest): boolean {
  return left !== null && sameContextTarget(left, right);
}

export function planContextAvailabilityBatch(
  input: Readonly<{
    commands: readonly ProjectDocumentAvailabilityCommand[];
    project: ContextRemovalProjectSnapshot;
    tabs: ProjectTabsSlice;
    recentRoutes: readonly WorkingSetRoute[];
    routeSearch: ProjectSearch | null;
    appliedGenerations: ReadonlyMap<string, AppliedAvailabilityCommand>;
    /** Documents a draft keeps on screen: their tabs stay when live loses them. */
    held?: ReadonlySet<string>;
  }>,
): ContextAvailabilityLocalBatchPlan {
  const projectId = input.commands[0]?.projectId ?? "";
  let tabs = [...input.tabs.tabs];
  let selectedDocumentId = selectedDocumentIdOf(input.tabs);
  let selection = input.project.selection;
  let admitted = input.project.admitted;
  let removalFence = input.project.removalFence;
  let transitionRevision = input.project.transitionRevision;
  let recentRoutes = [...input.recentRoutes];
  let routeSearch = input.routeSearch;
  let relocatedRouteDocumentId: string | null = null;
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
      const lineageId = entry.scope.kind === "lineage" ? entry.scope.rootThreadId : undefined;
      // A chat's upload is held by its chat: it keeps that owner through recency but has no
      // Editor route to plan.
      const chatId = entry.scope.kind === "chat" ? entry.scope.chatId : undefined;
      if (
        scheme === "uploads"
          ? !chatId
          : isWorkScopedScheme(scheme) && !lineageId && entry.scope.kind !== "work"
      )
        throw new Error("Availability requires the owner its scheme names");
      // A chat's Scratch keeps the Editor's own Work in its route, as a project document does.
      const lineageRef = lineageId
        ? (() => {
            const uri = parseContextUri(entry.uri);
            return uri.ok && uri.value.authority.kind === "lineage"
              ? uri.value.authority.rootThreadRef
              : undefined;
          })()
        : undefined;
      const target: ContextRouteRequest | null = chatId
        ? null
        : lineageId
          ? { scheme, path, rootThreadId: lineageId }
          : isWorkScopedScheme(scheme)
            ? entry.scope.kind === "work"
              ? { scheme, path, workId: entry.scope.workId }
              : null
            : { scheme, path };
      const priorTargets = tabs.flatMap((tab) =>
        tab.kind !== "new" && tab.documentId === id ? [routeTargetForTab(tab)] : [],
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
        const {
          workId: _oldWork,
          rootThreadId: _oldLineage,
          rootThreadRef: _oldHandle,
          ...withoutOwner
        } = common;
        if (chatId) return common as ContextTab;
        if (lineageId && lineageRef)
          return {
            ...withoutOwner,
            rootThreadId: lineageId,
            rootThreadRef: lineageRef,
          } as ContextTab;
        return isWorkScopedScheme(scheme) && target?.workId
          ? ({ ...withoutOwner, workId: target.workId } as ContextTab)
          : (withoutOwner as ContextTab);
      });
      if (
        target &&
        selection.status === "bound" &&
        selection.identity.kind === "server" &&
        selection.identity.documentId === id
      ) {
        admitted = target;
        // A review address owns its path: the item names where the draft puts the document,
        // which the live move is not.
        if (selection.by !== "review") {
          const previous = selection.locator;
          selection = { ...selection, locator: target };
          if (routeSearch && contextRouteMatchesSearch(routeSearch, previous)) {
            routeSearch = openContextRouteSearch(routeSearch, target);
            relocatedRouteDocumentId = id;
          }
        }
      } else if (target && priorTargets.some((prior) => sameTarget(admitted, prior))) {
        admitted = target;
      }
      const replacement = buildWorkingSetRoute(id, scheme, path, {
        workId: isWorkScopedScheme(scheme) && !lineageId ? target?.workId : undefined,
        rootThreadId: lineageId,
        chatId,
      });
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
      held: input.held,
    };
    const transition = reduceRepresentedRemoval(
      selection,
      tabs,
      intent,
      command.kind === "terminal-remove",
    );
    selection = transition.selection;
    const selectedTabId = input.project.activeWorkId ? selectedDocumentId : null;
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
    // A tab a draft holds open keeps the selection: the draft still paints in it.
    if (selectedDocumentId === id && !tabs.some((tab) => tab.documentId === id))
      selectedDocumentId = null;
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
    sessionEffects.push({
      commandId: command.commandId,
      operation: command.kind === "terminal-remove" ? "revoke-document" : "revoke-access",
      projectId,
      documentId: id,
      generation: command.generation,
      deletionVersion: command.kind === "terminal-remove" ? command.deletionVersion : null,
    });
  }

  if (unavailableWorkIds.size > 0) {
    const isUnavailable = (workId: string | null | undefined) =>
      workId != null && unavailableWorkIds.has(workId);
    recentRoutes = recentRoutes.filter(
      (route) => route.workId == null || !unavailableWorkIds.has(route.workId),
    );
    // Any Work's Scratch note can be on screen, whatever the scope is.
    if (selection.status !== "none" && isUnavailable(selection.locator.workId)) {
      selection = leaveSelection(selection).selection;
    }
    if (isUnavailable(admitted?.workId)) admitted = null;
    if (isUnavailable(input.routeSearch?.work) && routeSearch) {
      routeSearch = {
        ...routeSearch,
        screen: "context",
        work: undefined,
        chat: undefined,
        scheme: undefined,
        path: undefined,
      };
    }
  }

  return {
    projectId,
    commands: input.commands,
    tabs,
    selectedDocumentId,
    selection,
    admitted,
    removalFence,
    transitionRevision,
    recentRoutes,
    routeSearch,
    relocatedRouteDocumentId,
    generationRecords,
    sessionEffects,
  };
}
