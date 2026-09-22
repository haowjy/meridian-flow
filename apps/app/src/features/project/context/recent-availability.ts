/** Fold admitted availability into account recents. Catalog identity, not a second catalog. */
import { PROJECT_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import {
  isProjectContextTreeScheme,
  isWorkScopedProjectContextScheme,
} from "@meridian/contracts/protocol";
import { applyRecentAvailability, type RecentIdentityUpdate } from "@/client/recents";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

const EDITOR_SCHEMES = new Set<string>(PROJECT_SCOPED_CONTEXT_URI_SCHEMES);

export function recentAvailabilityFacts(commands: readonly ProjectDocumentAvailabilityCommand[]): {
  removed: { documentId: string; projectId: string }[];
  updates: RecentIdentityUpdate[];
} {
  const removed: { documentId: string; projectId: string }[] = [];
  const updates: RecentIdentityUpdate[] = [];
  for (const command of commands) {
    if (command.kind !== "available") {
      removed.push({ documentId: command.documentId, projectId: command.projectId });
      continue;
    }
    const separator = command.document.uri.indexOf(":");
    const scheme = separator < 0 ? "" : command.document.uri.slice(0, separator);
    const path = `/${command.document.path.join("/")}`;
    if (!isProjectContextTreeScheme(scheme) || !EDITOR_SCHEMES.has(scheme) || path === "/") {
      removed.push({ documentId: command.document.entryId, projectId: command.projectId });
      continue;
    }
    updates.push({
      documentId: command.document.entryId,
      name: command.document.name,
      scheme,
      path,
      workId:
        isWorkScopedProjectContextScheme(scheme) && command.document.scope.kind === "work"
          ? command.document.scope.workId
          : null,
    });
  }
  return { removed, updates };
}

export function reconcileRecentAvailability(
  accountId: string,
  commands: readonly ProjectDocumentAvailabilityCommand[],
): void {
  applyRecentAvailability(accountId, recentAvailabilityFacts(commands));
}
