import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export type ProjectNavigationTicket = { revision: number; key: string; href: string };
export type NavigationSettlement =
  | { kind: "applied" | "cancelled" | "superseded" }
  | {
      kind: "failed";
      error: unknown;
      ticket: ProjectNavigationTicket;
      stage: "before-acceptance" | "workspace-commit";
    };
export type PreparedWorkspaceNavigation = {
  isCurrent(): boolean;
  commit(): void;
  afterCommit?: () => void;
};

export type NavigationOptions = {
  afterCommit?: () => void;
  replace: boolean;
};

export type ContextRouteTarget = { documentId?: string; path: string } & (
  | { scheme: "scratch"; workId: string; rootThreadId?: undefined }
  | { scheme: "scratch"; rootThreadId: string; workId?: undefined }
  | {
      scheme: Exclude<ProjectContextTreeScheme, "scratch">;
      workId?: undefined;
      rootThreadId?: undefined;
    }
);

export type ContextRouteRequest =
  | ContextRouteTarget
  | {
      documentId?: string;
      path: string;
      scheme: "scratch";
      workId?: undefined;
      rootThreadId?: undefined;
    };

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
  showEditorRecents: (options: NavigationOptions) => Promise<NavigationSettlement>;
};
