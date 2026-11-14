/** Durable Agent revision/catalog storage participating in the app's ambient transaction. */
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@meridian/database";
import {
  agentCatalogEntries,
  agentCatalogRevisions,
  agentDefinitionRevisions,
  agentPackageInstallations,
  agentPackageRevisions,
  projectAgentRemovals,
  threadAgentBindings,
} from "@meridian/database/schema";
import { and, asc, eq, gt, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import {
  type CompiledAgentDefinition,
  compilePackage,
  type PackageDiagnostic,
} from "../domain/compile-package.js";
import { GRAMMAR_VERSION } from "../domain/mars.js";
import type { SkillFiles } from "../domain/skill-files.js";
import type {
  AgentRevision,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";

export function createDrizzleAgentRevisionStore(database: Database): AgentRevisionStore {
  const db = () => currentDrizzleDb(database);
  const ownerFilter = (userId: string | null) =>
    userId === null
      ? isNull(agentCatalogEntries.ownerUserId)
      : eq(agentCatalogEntries.ownerUserId, userId);
  const availableInProject = (projectId?: string) =>
    projectId
      ? notExists(
          db()
            .select()
            .from(projectAgentRemovals)
            .where(
              and(
                eq(projectAgentRemovals.projectId, projectId),
                eq(projectAgentRemovals.catalogEntryId, agentCatalogEntries.id),
              ),
            ),
        )
      : undefined;
  const catalogRevision = (row: typeof agentDefinitionRevisions.$inferSelect): CatalogRevision => ({
    id: row.id,
    packageRevisionId: row.packageRevisionId,
    slug: row.slug,
    grammarVersion: row.grammarVersion,
    name: row.name,
    description: row.description,
    diagnostics: row.diagnostics as PackageDiagnostic[],
    definition: row.definition as CompiledAgentDefinition | null,
  });
  const available = (row: CatalogRevision): AgentRevision[] =>
    row.definition
      ? [
          {
            id: row.id,
            packageRevisionId: row.packageRevisionId,
            slug: row.slug,
            grammarVersion: row.grammarVersion,
            definition: row.definition,
          },
        ]
      : [];

  const installationOwner = (owner: string | null) =>
    owner === null
      ? isNull(agentPackageInstallations.ownerUserId)
      : eq(agentPackageInstallations.ownerUserId, owner);
  const store: AgentRevisionStore = {
    async listInstallations(owner) {
      return db()
        .select()
        .from(agentPackageInstallations)
        .where(installationOwner(owner))
        .orderBy(asc(agentPackageInstallations.coordinate));
    },
    async listInstallationsWithoutRows(grammarVersion) {
      return db()
        .select()
        .from(agentPackageInstallations)
        .where(
          notExists(
            db()
              .select()
              .from(agentDefinitionRevisions)
              .where(
                and(
                  eq(
                    agentDefinitionRevisions.packageRevisionId,
                    agentPackageInstallations.currentRevisionId,
                  ),
                  eq(agentDefinitionRevisions.grammarVersion, grammarVersion),
                ),
              ),
          ),
        )
        .orderBy(asc(agentPackageInstallations.coordinate));
    },
    async advanceInstallation(input) {
      return store.withCatalogTransaction(input.ownerUserId, async () => {
        const { expectedRevisionId, ...values } = input;
        const identity = and(
          installationOwner(input.ownerUserId),
          eq(agentPackageInstallations.coordinate, input.coordinate),
        );
        const [existing] = await db().select().from(agentPackageInstallations).where(identity);
        if (
          existing
            ? existing.currentRevisionId !== expectedRevisionId
            : expectedRevisionId !== undefined
        )
          return undefined;
        const [row] = existing
          ? await db()
              .update(agentPackageInstallations)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(agentPackageInstallations.id, existing.id))
              .returning()
          : await db().insert(agentPackageInstallations).values(values).returning();
        return row;
      });
    },
    async withCatalogTransaction(ownerUserId, operation) {
      return runInDrizzleTransaction(database, async () => {
        // System logical keys span sources, including pointers an idempotent publication skips.
        await db().execute(
          sql`select pg_advisory_xact_lock(hashtext('agent-catalog'), hashtext(${ownerUserId === null ? "system-publication" : `account:${ownerUserId}`}))`,
        );
        return operation();
      });
    },
    async installSource(input, grammarVersion = GRAMMAR_VERSION) {
      const compiled = compilePackage(input, grammarVersion);
      return runInDrizzleTransaction(database, async () => {
        await db()
          .insert(agentPackageRevisions)
          .values({
            coordinate: compiled.coordinate,
            contentDigest: compiled.contentDigest,
            source: { files: compiled.files },
          })
          .onConflictDoNothing();
        const [source] = await db()
          .select()
          .from(agentPackageRevisions)
          .where(
            and(
              eq(agentPackageRevisions.coordinate, compiled.coordinate),
              eq(agentPackageRevisions.contentDigest, compiled.contentDigest),
            ),
          );
        if (compiled.agents.length) {
          await db()
            .insert(agentDefinitionRevisions)
            .values(
              compiled.agents.map((agent) => ({
                packageRevisionId: source.id,
                slug: agent.slug,
                grammarVersion,
                name: agent.name,
                description: agent.description,
                definition: agent.definition,
                diagnostics: agent.diagnostics,
              })),
            )
            .onConflictDoNothing();
        }
        return {
          packageRevisionId: source.id,
          definitions: await store.readPackageCatalogRevisions(source.id, grammarVersion),
        };
      });
    },
    async readPackageCatalogRevisions(packageRevisionId, grammarVersion) {
      const rows = await db()
        .select()
        .from(agentDefinitionRevisions)
        .where(
          and(
            eq(agentDefinitionRevisions.packageRevisionId, packageRevisionId),
            eq(agentDefinitionRevisions.grammarVersion, grammarVersion),
          ),
        )
        .orderBy(asc(agentDefinitionRevisions.slug));
      return rows.map(catalogRevision);
    },
    async readPackageDefinitions(packageRevisionId, grammarVersion) {
      return (await store.readPackageCatalogRevisions(packageRevisionId, grammarVersion)).flatMap(
        available,
      );
    },
    async readSource(id) {
      const [row] = await db()
        .select()
        .from(agentPackageRevisions)
        .where(eq(agentPackageRevisions.id, id));
      if (!row) return undefined;
      return { coordinate: row.coordinate, files: (row.source as { files: SkillFiles }).files };
    },
    async readCatalogRevision(id) {
      const [row] = await db()
        .select()
        .from(agentDefinitionRevisions)
        .where(eq(agentDefinitionRevisions.id, id));
      return row ? catalogRevision(row) : undefined;
    },
    async readRevision(id) {
      const row = await store.readCatalogRevision(id);
      return row ? available(row)[0] : undefined;
    },
    async selectRevision(input) {
      return runInDrizzleTransaction(database, async () => {
        const target = await store.readCatalogRevision(input.revisionId);
        if (!target) return { ok: false, reason: "not-found" };
        const name = target.name;
        const selection = {
          selectedRevisionId: target.id,
          name,
          nameSortKey: name.normalize("NFC").toLowerCase(),
        };
        const identity = and(
          ownerFilter(input.ownerUserId),
          eq(agentCatalogEntries.logicalKey, input.logicalKey),
        );
        if (input.expectedRevisionId !== undefined) {
          const [entry] = await db()
            .update(agentCatalogEntries)
            .set({ ...selection, updatedAt: new Date() })
            .where(
              and(
                identity,
                eq(agentCatalogEntries.removed, false),
                eq(agentCatalogEntries.selectedRevisionId, input.expectedRevisionId),
              ),
            )
            .returning();
          if (!entry) return { ok: false, reason: "conflict" };
          await db()
            .insert(agentCatalogRevisions)
            .values({
              catalogEntryId: entry.id,
              definitionRevisionId: input.expectedRevisionId,
            })
            .onConflictDoNothing();
          return { ok: true, entry };
        }
        const [created] = await db()
          .insert(agentCatalogEntries)
          .values({
            ownerUserId: input.ownerUserId,
            logicalKey: input.logicalKey,
            ...selection,
          })
          .onConflictDoNothing()
          .returning();
        if (created) return { ok: true, entry: created };
        const [existing] = await db().select().from(agentCatalogEntries).where(identity);
        return existing && !existing.removed && existing.selectedRevisionId === target.id
          ? { ok: true, entry: existing }
          : { ok: false, reason: "conflict" };
      });
    },
    async readCatalogEntry(ownerUserId, logicalKey) {
      const [entry] = await db()
        .select()
        .from(agentCatalogEntries)
        .where(and(ownerFilter(ownerUserId), eq(agentCatalogEntries.logicalKey, logicalKey)));
      return entry;
    },
    async readSelection(userId, catalogEntryId, revisionId, projectId) {
      const [row] = await db()
        .select({ entry: agentCatalogEntries, revision: agentDefinitionRevisions })
        .from(agentCatalogEntries)
        .leftJoin(
          agentCatalogRevisions,
          and(
            eq(agentCatalogRevisions.catalogEntryId, agentCatalogEntries.id),
            eq(agentCatalogRevisions.definitionRevisionId, revisionId),
          ),
        )
        .innerJoin(agentDefinitionRevisions, eq(agentDefinitionRevisions.id, revisionId))
        .where(
          and(
            eq(agentCatalogEntries.id, catalogEntryId),
            eq(agentDefinitionRevisions.grammarVersion, GRAMMAR_VERSION),
            availableInProject(projectId),
            or(ownerFilter(null), ownerFilter(userId)),
            eq(agentCatalogEntries.removed, false),
            or(
              eq(agentCatalogEntries.selectedRevisionId, revisionId),
              isNotNull(agentCatalogRevisions.definitionRevisionId),
            ),
          ),
        );
      return row ? { entry: row.entry, revision: catalogRevision(row.revision) } : undefined;
    },
    async listCatalog(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new Error("Agent catalog limit must be between 1 and 100");
      }
      return db()
        .select()
        .from(agentCatalogEntries)
        .where(
          and(
            or(ownerFilter(null), ownerFilter(input.userId)),
            availableInProject(input.projectId),
            eq(agentCatalogEntries.removed, false),
            input.after
              ? or(
                  gt(agentCatalogEntries.nameSortKey, input.after.nameSortKey),
                  and(
                    eq(agentCatalogEntries.nameSortKey, input.after.nameSortKey),
                    gt(agentCatalogEntries.id, input.after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(agentCatalogEntries.nameSortKey), asc(agentCatalogEntries.id))
        .limit(input.limit);
    },
    async removeFromProject(projectId, catalogEntryId) {
      await db()
        .insert(projectAgentRemovals)
        .values({ projectId, catalogEntryId })
        .onConflictDoNothing();
    },
    async removeOwnedEntry(userId, id) {
      const rows = await db()
        .update(agentCatalogEntries)
        .set({ removed: true, updatedAt: new Date() })
        .where(
          and(
            eq(agentCatalogEntries.id, id),
            ownerFilter(userId),
            eq(agentCatalogEntries.removed, false),
          ),
        )
        .returning({ id: agentCatalogEntries.id });
      return rows.length === 1;
    },
    async bindThread(threadId, definitionRevisionId, configuration, invocationOverlay) {
      await db()
        .insert(threadAgentBindings)
        .values({ threadId, definitionRevisionId, configuration, invocationOverlay })
        .onConflictDoNothing();
      const [binding] = await db()
        .select()
        .from(threadAgentBindings)
        .where(eq(threadAgentBindings.threadId, threadId));
      return (
        binding.definitionRevisionId === definitionRevisionId &&
        isDeepStrictEqual(binding.configuration, configuration) &&
        isDeepStrictEqual(binding.invocationOverlay, invocationOverlay)
      );
    },
    async readThreadBinding(threadId) {
      const [row] = await db()
        .select({
          revision: agentDefinitionRevisions,
          configuration: threadAgentBindings.configuration,
          invocationOverlay: threadAgentBindings.invocationOverlay,
          invokedSkills: threadAgentBindings.invokedSkills,
        })
        .from(threadAgentBindings)
        .leftJoin(
          agentDefinitionRevisions,
          eq(agentDefinitionRevisions.id, threadAgentBindings.definitionRevisionId),
        )
        .where(eq(threadAgentBindings.threadId, threadId));
      if (!row) return undefined;
      const bound = row.revision?.id ? available(catalogRevision(row.revision))[0] : undefined;
      if (row.revision?.id && !bound) {
        throw new Error(`Thread ${threadId} is bound to an Agent revision with no definition`);
      }
      return {
        revision: bound ?? null,
        configuration: row.configuration,
        invocationOverlay: row.invocationOverlay,
        invokedSkills: row.invokedSkills,
      };
    },
    async recordInvokedSkill(threadId, slug, reference) {
      const rows = await db()
        .update(threadAgentBindings)
        .set({
          invokedSkills: sql`${threadAgentBindings.invokedSkills} || jsonb_build_object(${slug}::text, ${JSON.stringify(reference)}::jsonb)`,
        })
        .where(eq(threadAgentBindings.threadId, threadId))
        .returning({ threadId: threadAgentBindings.threadId });
      return rows.length === 1;
    },
  };
  return store;
}
