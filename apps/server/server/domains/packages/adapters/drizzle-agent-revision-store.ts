/** Durable Agent revision/catalog storage participating in the app's ambient transaction. */
import type { Database } from "@meridian/database";
import {
  agentCatalogEntries,
  agentDefinitionRevisions,
  agentPackageRevisions,
  threadAgentBindings,
} from "@meridian/database/schema";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
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

  const store: AgentRevisionStore = {
    async installSource(input) {
      const prepared = prepareAgentSourceRevision(input);
      return runInDrizzleTransaction(database, async () => {
        const { definitions, ...sourceRow } = prepared;
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
      return row
        ? { coordinate: row.coordinate, files: (row.source as { files: SkillFiles }).files }
        : undefined;
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
          return entry ? { ok: true, entry } : { ok: false, reason: "conflict" };
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
    async bindThread(threadId, definitionRevisionId) {
      await db()
        .insert(threadAgentBindings)
        .values({ threadId, definitionRevisionId })
        .onConflictDoNothing();
      const [binding] = await db()
        .select()
        .from(threadAgentBindings)
        .where(eq(threadAgentBindings.threadId, threadId));
      return binding.definitionRevisionId === definitionRevisionId;
    },
    async readThreadBinding(threadId) {
      const [row] = await db()
        .select({ revision: agentDefinitionRevisions })
        .from(threadAgentBindings)
        .innerJoin(
          agentDefinitionRevisions,
          eq(agentDefinitionRevisions.id, threadAgentBindings.definitionRevisionId),
        )
        .where(eq(threadAgentBindings.threadId, threadId));
      return row ? revision(row.revision) : undefined;
    },
  };
  return store;
}
