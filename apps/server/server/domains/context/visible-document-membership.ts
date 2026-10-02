/** Shared manifest visibility policy for manuscript observations. */
import type { BranchPeerShadowAccess } from "../collab/index.js";
import type { ContextScheme } from "./ports/context-port.js";

export type ManifestMembershipResolver = Pick<BranchPeerShadowAccess, "resolveManifestMembership">;

export async function resolveVisibleDocumentMembership(input: {
  scheme: ContextScheme;
  view?: {
    projectId: string;
    workId?: string | null;
    threadId?: string | null;
    responseId?: string | null;
  };
  resolver: ManifestMembershipResolver;
}): Promise<Set<string> | null> {
  if (input.scheme !== "manuscript" || !input.view) return null;
  try {
    const membership = await input.resolver.resolveManifestMembership({
      projectId: input.view.projectId as never,
      workId: input.view.workId as never,
      threadId: input.view.threadId as never,
      responseId: input.view.responseId,
    });
    return membership.documentId ? new Set(membership.members) : null;
  } catch {
    // Authority failure is not permission to expose raw rows. Creation paths
    // can repair an occupied row; observations remain fail-closed.
    return new Set();
  }
}
