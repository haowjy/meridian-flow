import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

export const LINKABLE_SCHEMES = [
  "manuscript",
  "kb",
  "unfiled",
  "agents",
  "user",
  "scratch",
  "uploads",
] as const satisfies readonly ProjectContextTreeScheme[];

export type LinkableScopes = {
  projectId: string;
  workId: string | null;
  rootThreadId: string | null;
  chatThreadId: string | null;
};

export function linkableScopes({
  projectId,
  workId,
  rootThreadId,
  chatThreadId,
}: {
  projectId: string | null;
  workId: string | null;
  rootThreadId?: string | null;
  chatThreadId?: string | null;
}): LinkableScopes | null {
  if (!projectId || !workId) return null;
  return {
    projectId,
    workId,
    rootThreadId: rootThreadId ?? null,
    chatThreadId: chatThreadId ?? null,
  };
}
