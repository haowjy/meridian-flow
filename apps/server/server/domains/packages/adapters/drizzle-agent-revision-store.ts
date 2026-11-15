/** Durable Agent revision/catalog storage participating in the app's ambient transaction. */
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@meridian/database";
import {
  agentDefinitionRevisions,
  agentPackageRevisions,
  threadAgentBindings,
} from "@meridian/database/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import {
  type CompiledAgentDefinition,
  compilePackage,
  type PackageDiagnostic,
} from "../domain/compile-package.js";
import { agentRevisionId } from "../domain/helpers.js";
import { GRAMMAR_VERSION } from "../domain/mars.js";
import type { SkillFiles } from "../domain/types.js";
import type {
  AgentRevision,
  AgentRevisionStore,
  CatalogRevision,
} from "../ports/agent-revision-store.js";

export function createDrizzleAgentRevisionStore(database: Database): AgentRevisionStore {
  const db = () => currentDrizzleDb(database);
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

  const store: AgentRevisionStore = {
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
                id: agentRevisionId(compiled, agent.slug, grammarVersion),
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
