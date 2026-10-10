/** Checked owner construction at command boundaries and one durable URI authority rule. */
import type { ParsedContextAuthority } from "@meridian/contracts/context-uri";
import {
  type CatalogScope,
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { ResourceOwner } from "./resource-records";

/** The locked row is separate from named Works in the project's authoritative snapshot. */
export function resourceWorkAuthorityFor(
  workId: string,
  snapshot: { works: readonly { id: string; slug: string | null }[]; noWork: { id: string } },
): ResourceOwner {
  if (workId === snapshot.noWork.id) return { workId, workSlug: null };
  const work = snapshot.works.find((candidate) => candidate.id === workId);
  if (!work?.slug) throw new Error("The destination Work has no known named authority");
  return { workId: work.id, workSlug: work.slug };
}

/** The owner a lineage catalog entry asserts: the scope's first-chat id and the handle its URI spells. */
export function resourceLineageOwner(
  scope: Extract<CatalogScope, { kind: "lineage" }>,
  rootThreadRef: string,
): ResourceOwner {
  return { workId: null, rootThreadId: scope.rootThreadId, rootThreadRef };
}

/** What a location's owner spells in a context URI. */
export type ResourceContextAuthority =
  | { kind: "contextual" }
  | { kind: "none" }
  | { kind: "work"; workSlug: string }
  | { kind: "lineage"; rootThreadRef: string };

/** Journal identity was checked against a Works snapshot or asserted by a scoped server catalog. */
export function resourceContextAuthority(
  scheme: ProjectContextTreeScheme,
  owner: {
    workId: string | null;
    workSlug?: string | null;
    rootThreadId?: string | null;
    rootThreadRef?: string | null;
  },
): ResourceContextAuthority {
  if (!isWorkScopedProjectContextScheme(scheme)) return { kind: "contextual" };
  if (owner.rootThreadId) {
    if (scheme !== "scratch" || owner.workId !== null || !owner.rootThreadRef)
      throw new Error("Lineage authority requires Scratch and a first-chat handle");
    return { kind: "lineage", rootThreadRef: owner.rootThreadRef };
  }
  if (!owner.workId || owner.workSlug === undefined)
    throw new Error("Work-scoped authority requires a known Work identity");
  return owner.workSlug === null ? { kind: "none" } : { kind: "work", workSlug: owner.workSlug };
}

/** The authority's spelling in a URI: nothing for contextual, `@arc/`, `@/` or `@/c12/`. */
export function resourceUriQualifier(authority: ResourceContextAuthority): string {
  switch (authority.kind) {
    case "contextual":
      return "";
    case "none":
      return "@/";
    case "work":
      return `@${authority.workSlug}/`;
    case "lineage":
      return `@/${authority.rootThreadRef}/`;
  }
}

/** The owner a catalog entry asserts through its scope and the authority its URI spells. */
export function catalogEntryOwner(
  scope: CatalogScope,
  authority: ParsedContextAuthority,
): ResourceOwner {
  if (scope.kind === "lineage")
    return authority.kind === "lineage"
      ? resourceLineageOwner(scope, authority.rootThreadRef)
      : { workId: null };
  if (scope.kind !== "work") return { workId: null };
  return { workId: scope.workId, workSlug: authority.kind === "work" ? authority.workSlug : null };
}

/** Whether a catalog scope is where this owner's documents are listed. */
export function ownerListedInScope(
  owner: ResourceOwner,
  scheme: ProjectContextTreeScheme,
  scope: CatalogScope,
  projectId: string,
): boolean {
  if (owner.rootThreadId !== undefined)
    return scope.kind === "lineage" && scope.rootThreadId === owner.rootThreadId;
  if (owner.workId !== null) return scope.kind === "work" && scope.workId === owner.workId;
  return scheme === "user"
    ? scope.kind === "user"
    : scope.kind === "project" && scope.projectId === projectId;
}

/** The owner fields a move request carries for its source and destination locations. */
export function moveOwnerFields(source: ResourceOwner, destination: ResourceOwner) {
  return {
    sourceWorkSlug: source.workSlug ?? null,
    destinationWorkSlug: destination.workSlug ?? null,
    sourceRootThreadRef: source.rootThreadRef ?? null,
    destinationRootThreadRef: destination.rootThreadRef ?? null,
    body: {
      sourceWorkId: source.workId,
      destinationWorkId: destination.workId,
      sourceRootThreadId: source.rootThreadId ?? null,
      destinationRootThreadId: destination.rootThreadId ?? null,
    },
  };
}
