/** Shared manifest visibility policy for manuscript observations. */
import type { BranchPeerShadowAccess } from "../collab/index.js";
import type { ContextScheme } from "./ports/context-port.js";

export type ManifestMembershipResolver = Pick<BranchPeerShadowAccess, "resolveManifestMembership">;

async function resolveMembership(input: {
  view: NonNullable<Parameters<typeof resolveVisibleDocumentMembership>[0]["view"]>;
  resolver: ManifestMembershipResolver;
}): Promise<Set<string> | null> {
  const membership = await input.resolver.resolveManifestMembership({
    projectId: input.view.projectId as never,
    workId: input.view.workId as never,
    threadId: input.view.threadId as never,
    responseId: input.view.responseId,
  });
  return membership.documentId ? new Set(membership.members) : null;
}

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
    return await resolveMembership({ view: input.view, resolver: input.resolver });
  } catch {
    // Authority failure is not permission to expose raw rows. Creation paths
    // can repair an occupied row; observations remain fail-closed.
    return new Set();
  }
}

/** Reconciliation must preserve the last good catalog when authority cannot be read. */
export function resolveCatalogDocumentMembership(input: {
  projectId: string;
  resolver: ManifestMembershipResolver;
}): Promise<Set<string> | null> {
  return resolveMembership({ view: { projectId: input.projectId }, resolver: input.resolver });
}
