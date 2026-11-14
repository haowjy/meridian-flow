/** Stable-ID navigation commands, not browser grammar. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { NavigationSettlement } from "./project-navigation";

export type NavigationOptions = {
  afterCommit?: () => void;
  replace: boolean;
};

/**
 * A document's route. The owner is a fact about a Scratch note only: `workId` names a Work's
 * Scratch owner, `rootThreadId` a No Work chat's. Every other document has neither, so the
 * Work scope never takes part in its identity.
 */
export type ContextRouteTarget = { documentId?: string; path: string } & (
  | { scheme: "scratch"; workId: string; rootThreadId?: undefined }
  | { scheme: "scratch"; rootThreadId: string; workId?: undefined }
  | {
      scheme: Exclude<ProjectContextTreeScheme, "scratch">;
      workId?: undefined;
      rootThreadId?: undefined;
    }
);

/**
 * What a route or a caller names: a Scratch note may leave its owner out (a link without one,
 * or a caller leaving it to the scope's Work).
 */
export type ContextRouteRequest =
  | ContextRouteTarget
  | {
      documentId?: string;
      path: string;
      scheme: "scratch";
      workId?: undefined;
      rootThreadId?: undefined;
    };

/** Loose route fields (a URL, a tab, a chat link) to a request: the owner survives for Scratch only. */
export function contextRouteRequest(parts: {
  scheme: ProjectContextTreeScheme;
  path: string;
  documentId?: string | undefined;
  workId?: string | null | undefined;
  rootThreadId?: string | null | undefined;
}): ContextRouteRequest {
  const { scheme, path, documentId } = parts;
  const base = documentId ? { path, documentId } : { path };
  if (scheme !== "scratch") return { ...base, scheme };
  if (parts.rootThreadId) return { ...base, scheme, rootThreadId: parts.rootThreadId };
  if (parts.workId) return { ...base, scheme, workId: parts.workId };
  return { ...base, scheme };
}

export type ProjectRouteCommands = {
  /** Editor destination with no document and no local history pointer. */
  showEditorRecents: (options: NavigationOptions) => Promise<NavigationSettlement>;
};
