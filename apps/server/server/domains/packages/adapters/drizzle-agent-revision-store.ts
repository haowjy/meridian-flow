/** Durable Agent revision/catalog storage participating in the app's ambient transaction. */
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@meridian/database";
import {
  agentCatalogEntries,
  agentCatalogRevisions,
  agentDefinitionRevisions,
  agentPackageDependencies,
  agentPackageInstallationHistory,
  agentPackageInstallations,
  agentPackageRevisions,
  threadAgentBindings,
} from "@meridian/database/schema";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { CompiledAgentDefinition } from "../domain/agent-definition-compiler.js";
import { prepareAgentSourceRevision } from "../domain/agent-source-revision.js";
import type { SkillFiles } from "../domain/skill-files.js";
import type { AgentRevision, AgentRevisionStore } from "../ports/agent-revision-store.js";

export function createDrizzleAgentRevisionStore(database: Database): AgentRevisionStore {
  const db = () => currentDrizzleDb(database);
  const ownerFilter = (userId: string | null) =>
    userId === null
      ? isNull(agentCatalogEntries.ownerUserId)
      : eq(agentCatalogEntries.ownerUserId, userId);
  const revision = (row: typeof agentDefinitionRevisions.$inferSelect): AgentRevision => ({
    id: row.id,
    packageRevisionId: row.packageRevisionId,
    slug: row.slug,
    definition: row.definition as CompiledAgentDefinition,
    definitionDigest: row.definitionDigest,
  });

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
    async readInstallationHistory(owner, installationId) {
      const rows = await db()
        .select({
          packageRevisionId: agentPackageInstallationHistory.packageRevisionId,
          createdAt: agentPackageInstallationHistory.createdAt,
        })
        .from(agentPackageInstallationHistory)
        .innerJoin(
          agentPackageInstallations,
          eq(agentPackageInstallations.id, agentPackageInstallationHistory.installationId),
        )
        .where(and(installationOwner(owner), eq(agentPackageInstallations.id, installationId)))
        .orderBy(
          asc(agentPackageInstallationHistory.createdAt),
          asc(agentPackageInstallationHistory.packageRevisionId),
        );
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
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
        await db()
          .insert(agentPackageInstallationHistory)
          .values(
            [...new Set([input.currentRevisionId, input.upstreamRevisionId])].map(
              (packageRevisionId) => ({ installationId: row.id, packageRevisionId }),
            ),
          )
          .onConflictDoNothing();
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
    async installSource(input) {
      const prepared = prepareAgentSourceRevision(input);
      return runInDrizzleTransaction(database, async () => {
        const { definitions, dependencies, ...sourceRow } = prepared;
        await db().insert(agentPackageRevisions).values(sourceRow).onConflictDoNothing();
        const [source] = await db()
          .select()
          .from(agentPackageRevisions)
          .where(
            and(
              eq(agentPackageRevisions.coordinate, prepared.coordinate),
              eq(agentPackageRevisions.contentDigest, prepared.contentDigest),
            ),
          );
        if (Object.keys(dependencies).length) {
          await db()
            .insert(agentPackageDependencies)
            .values(
              Object.entries(dependencies).map(([name, dependencyRevisionId]) => ({
                packageRevisionId: source.id,
                name,
                dependencyRevisionId,
              })),
            )
            .onConflictDoNothing();
        }
        if (definitions.length) {
          await db()
            .insert(agentDefinitionRevisions)
            .values(
              definitions.map((item) => ({
                ...item,
                packageRevisionId: source.id,
              })),
            )
            .onConflictDoNothing();
        }
        return {
          packageRevisionId: source.id,
          definitions: await store.readPackageDefinitions(source.id),
        };
      });
    },
    async readPackageDefinitions(packageRevisionId) {
      const rows = await db()
        .select()
        .from(agentDefinitionRevisions)
        .where(eq(agentDefinitionRevisions.packageRevisionId, packageRevisionId))
        .orderBy(asc(agentDefinitionRevisions.slug));
      return rows.map(revision);
    },
    async readSource(id) {
      const [row] = await db()
        .select()
        .from(agentPackageRevisions)
        .where(eq(agentPackageRevisions.id, id));
      if (!row) return undefined;
      const dependencies = await db()
        .select()
        .from(agentPackageDependencies)
        .where(eq(agentPackageDependencies.packageRevisionId, id));
      return {
        coordinate: row.coordinate,
        files: (row.source as { files: SkillFiles }).files,
        dependencies: Object.fromEntries(
          dependencies.map((item) => [item.name, item.dependencyRevisionId]),
        ),
      };
    },
    async readRevision(id) {
      const [row] = await db()
        .select()
        .from(agentDefinitionRevisions)
        .where(eq(agentDefinitionRevisions.id, id));
      return row ? revision(row) : undefined;
    },
    async selectRevision(input) {
      return runInDrizzleTransaction(database, async () => {
        const target = await store.readRevision(input.revisionId);
        if (!target) return { ok: false, reason: "not-found" };
        const name = target.definition.metadata.name ?? target.slug;
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
    async readSelection(userId, catalogEntryId, revisionId) {
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
            or(ownerFilter(null), ownerFilter(userId)),
            eq(agentCatalogEntries.removed, false),
            or(
              eq(agentCatalogEntries.selectedRevisionId, revisionId),
              isNotNull(agentCatalogRevisions.definitionRevisionId),
            ),
          ),
        );
      return row ? { entry: row.entry, revision: revision(row.revision) } : undefined;
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
    async restoreOwnedEntry(userId, id, expectedRevisionId) {
      const rows = await db()
        .update(agentCatalogEntries)
        .set({ removed: false, updatedAt: new Date() })
        .where(
          and(
            eq(agentCatalogEntries.id, id),
            ownerFilter(userId),
            eq(agentCatalogEntries.removed, true),
            eq(agentCatalogEntries.selectedRevisionId, expectedRevisionId),
          ),
        )
        .returning({ id: agentCatalogEntries.id });
      return rows.length === 1;
    },
    async bindThread(threadId, definitionRevisionId, configuration) {
      await db()
        .insert(threadAgentBindings)
        .values({ threadId, definitionRevisionId, configuration })
        .onConflictDoNothing();
      const [binding] = await db()
        .select()
        .from(threadAgentBindings)
        .where(eq(threadAgentBindings.threadId, threadId));
      return (
        binding.definitionRevisionId === definitionRevisionId &&
        isDeepStrictEqual(binding.configuration, configuration)
      );
    },
    async readThreadBinding(threadId) {
      const [row] = await db()
        .select({
          revision: agentDefinitionRevisions,
          configuration: threadAgentBindings.configuration,
        })
        .from(threadAgentBindings)
        .innerJoin(
          agentDefinitionRevisions,
          eq(agentDefinitionRevisions.id, threadAgentBindings.definitionRevisionId),
        )
        .where(eq(threadAgentBindings.threadId, threadId));
      return row ? { ...revision(row.revision), configuration: row.configuration } : undefined;
    },
  };
  return store;
}
