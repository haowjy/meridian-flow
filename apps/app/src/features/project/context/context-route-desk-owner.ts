/** Exact, heuristic-free resolution of the Context desk owner for one committed route. */

import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { ContextTab } from "@/client/stores";
import type { ContextRouteTarget } from "../routing/project-route";
import type { ContextRouteIdentity } from "./context-removal-planner";
import { contextTabMatchesRoute } from "./context-tab-identity";

export type DeskRouteResolution =
  | { kind: "owner"; tab: ContextTab; identity: ContextRouteIdentity }
  | {
      kind: "materialized-local";
      tab: Extract<ContextTab, { kind: "tracked" }>;
      target: ContextRouteTarget;
    }
  | { kind: "unowned" };

export function resolveDeskRoute({
  tabs,
  selectedDocumentId,
  locator,
}: {
  tabs: readonly ContextTab[];
  selectedDocumentId: string | undefined;
  locator: ContextRouteTarget | null;
}): DeskRouteResolution {
  if (!locator) return { kind: "unowned" };
  const server = tabs.find(
    (tab) =>
      tab.kind !== "new" &&
      contextTabMatchesRoute(tab, locator.scheme, locator.path, locator.workId),
  );
  if (server) {
    return {
      kind: "owner",
      tab: server,
      identity: { kind: "server", documentId: server.documentId },
    };
  }
  if (locator.scheme !== "scratch" || locator.path !== "" || !selectedDocumentId) {
    return { kind: "unowned" };
  }
  const selected = tabs.find((tab) => tab.documentId === selectedDocumentId);
  if (selected?.kind === "new" && selected.workId === locator.workId) {
    return {
      kind: "owner",
      tab: selected,
      identity: { kind: "local", documentId: selected.documentId },
    };
  }
  if (
    selected?.kind === "tracked" &&
    selected.origin === "local-untitled" &&
    (!isWorkScopedProjectContextScheme(selected.scheme) || selected.workId === locator.workId)
  ) {
    return {
      kind: "materialized-local",
      tab: selected,
      target: {
        scheme: selected.scheme,
        path: selected.path,
        workId: isWorkScopedProjectContextScheme(selected.scheme)
          ? (selected.workId ?? null)
          : locator.workId,
      },
    };
  }
  return { kind: "unowned" };
}
