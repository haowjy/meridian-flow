/** Atomic source publication: management provenance and future-chat pointers share one owner. */
import type { AgentRevisionStore } from "../ports/agent-revision-store.js";
import type { AgentSourceSnapshot } from "./compile-package.js";
import { agentSlugOf, GRAMMAR_VERSION, skillSlugOf } from "./mars.js";

export class AgentPublicationConflictError extends Error {}

/** Agents and skills a source defines, by path alone: the collision check needs identities, not content. */
function sourceEntities(
  source: AgentSourceSnapshot,
): Array<{ kind: "agent" | "skill"; slug: string }> {
  const entities: Array<{ kind: "agent" | "skill"; slug: string }> = [];
  for (const name of Object.keys(source.files).sort()) {
    const agent = agentSlugOf(name);
    if (agent !== undefined) entities.push({ kind: "agent", slug: agent });
    const skill = skillSlugOf(name);
    if (skill !== undefined) entities.push({ kind: "skill", slug: skill });
  }
  return entities;
}

export async function publishAgentSource(input: {
  store: AgentRevisionStore;
  ownerUserId: string | null;
  source: AgentSourceSnapshot;
  expectedRevisionId?: string;
  grammarVersion?: string;
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
    const installed = await store.installSource(source, input.grammarVersion);
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
      const entry = await store.readCatalogEntry(ownerUserId, revision.slug);
      if (entry) {
        const previous = await store.readCatalogRevision(entry.selectedRevisionId);
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
      const previousSource = await store.readSource(existing.currentRevisionId);
      if (!previousSource) throw new Error("Installed package references missing retained source");
      for (const previous of sourceEntities(previousSource)) {
        if (previous.kind !== "agent") continue;
        if (installed.definitions.some((item) => item.slug === previous.slug)) continue;
        const entry = await store.readCatalogEntry(ownerUserId, previous.slug);
        if (entry) await store.removeOwnedEntry(ownerUserId, entry.id);
      }
    }
    const installation = await store.advanceInstallation({
      ownerUserId,
      coordinate: source.coordinate,
      currentRevisionId: installed.packageRevisionId,
      ...(existing ? { expectedRevisionId: existing.currentRevisionId } : {}),
    });
    if (!installation)
      throw new AgentPublicationConflictError("Package head changed during publication.");
    return { ...installed, installation };
  });
}

/**
 * After a reader change, every package whose current file set has no rows at the running
 * version is published again through the same path seeding uses, so its catalog entries
 * advance. Chats already bound keep their revisions. With no change it finds nothing.
 */
export async function recompileStalePackages(store: AgentRevisionStore): Promise<void> {
  for (const listed of await store.listInstallationsWithoutRows(GRAMMAR_VERSION)) {
    // Another instance booting or saving may have moved the head since the list above, so
    // recompile whatever the head is now, and skip only when its rows already exist.
    await store.withCatalogTransaction(listed.ownerUserId, async () => {
      const head = (await store.listInstallationsWithoutRows(GRAMMAR_VERSION)).find(
        (item) => item.ownerUserId === listed.ownerUserId && item.coordinate === listed.coordinate,
      );
      if (!head) return;
      const source = await store.readSource(head.currentRevisionId);
      if (!source || !Object.keys(source.files).some((path) => agentSlugOf(path) !== undefined)) {
        return;
      }
      await publishAgentSource({
        store,
        ownerUserId: head.ownerUserId,
        source,
        expectedRevisionId: head.currentRevisionId,
      });
    });
  }
}
