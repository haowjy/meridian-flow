/** Atomic source publication: management provenance and future-chat pointers share one owner. */
import type {
  AgentPackageInstallation,
  AgentRevisionStore,
} from "../ports/agent-revision-store.js";
import { resolveAgentDependencies } from "./agent-configuration.js";
import type { AgentSourceSnapshot } from "./agent-source-revision.js";
import { sourceEntities } from "./package-reconciliation.js";

export class AgentPublicationConflictError extends Error {}

export async function publishAgentSource(input: {
  store: AgentRevisionStore;
  ownerUserId: string | null;
  source: AgentSourceSnapshot;
  expectedRevisionId?: string;
  upstreamRevisionId?: string;
  origin?: AgentPackageInstallation["origin"];
}) {
  const { store, ownerUserId, source } = input;
  return store.withCatalogTransaction(ownerUserId, async () => {
    const installations = await store.listInstallations(ownerUserId);
    const existing = installations.find((item) => item.coordinate === source.coordinate);
    const identities = new Set(
      sourceEntities(source).map((entity) => `${entity.kind}/${entity.slug}`),
    );
    for (const installation of installations) {
      if (installation.coordinate === source.coordinate) continue;
      const other = await store.readSource(installation.currentRevisionId);
      if (!other) throw new Error("Installed package references missing retained source");
      for (const entity of sourceEntities(other)) {
        if (identities.has(`${entity.kind}/${entity.slug}`))
          throw new AgentPublicationConflictError(
            `${entity.kind} "${entity.slug}" belongs to source "${installation.coordinate}". Rename it before publishing "${source.coordinate}".`,
          );
      }
    }
    const installed = await store.installSource(source);
    if (
      existing &&
      existing.currentRevisionId !== input.expectedRevisionId &&
      existing.currentRevisionId !== installed.packageRevisionId
    ) {
      throw new AgentPublicationConflictError(
        "Package changed since it was read; reload before saving.",
      );
    }
    if (!existing && input.expectedRevisionId !== undefined)
      throw new AgentPublicationConflictError("Package installation is missing.");
    for (const revision of installed.definitions) {
      await resolveAgentDependencies({ revision, store });
      const entry = await store.readCatalogEntry(ownerUserId, revision.slug);
      if (entry) {
        const previous = await store.readRevision(entry.selectedRevisionId);
        const previousSource = previous && (await store.readSource(previous.packageRevisionId));
        if (previousSource?.coordinate !== source.coordinate) {
          throw new AgentPublicationConflictError(
            `Agent "${revision.slug}" belongs to source "${previousSource?.coordinate}". Rename it before importing "${source.coordinate}".`,
          );
        }
      }
      // Removal is an explicit user action; editing a source must not undo it.
      if (entry?.removed || entry?.selectedRevisionId === revision.id) continue;
      const selected = await store.selectRevision({
        ownerUserId,
        logicalKey: revision.slug,
        revisionId: revision.id,
        ...(entry ? { expectedRevisionId: entry.selectedRevisionId } : {}),
      });
      if (!selected.ok)
        throw new AgentPublicationConflictError(`Agent selection changed: ${revision.slug}`);
    }
    if (existing) {
      const previousDefinitions = await store.readPackageDefinitions(existing.currentRevisionId);
      for (const previous of previousDefinitions) {
        if (installed.definitions.some((item) => item.slug === previous.slug)) continue;
        const entry = await store.readCatalogEntry(ownerUserId, previous.slug);
        if (entry) await store.removeOwnedEntry(ownerUserId, entry.id);
      }
    }
    const installation = await store.advanceInstallation({
      ownerUserId,
      coordinate: source.coordinate,
      currentRevisionId: installed.packageRevisionId,
      upstreamRevisionId:
        input.upstreamRevisionId ?? existing?.upstreamRevisionId ?? installed.packageRevisionId,
      origin: input.origin === undefined ? (existing?.origin ?? null) : input.origin,
      ...(existing ? { expectedRevisionId: existing.currentRevisionId } : {}),
    });
    if (!installation)
      throw new AgentPublicationConflictError("Package head changed during publication.");
    return { ...installed, installation };
  });
}
