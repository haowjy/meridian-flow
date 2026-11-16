/** Durable Agent revision/catalog storage participating in the app's ambient transaction. */
import { isDeepStrictEqual } from "node:util";
import type { Database } from "@meridian/database";
import {
  agentDefinitionRevisions,
  agentPackageRevisions,
  agentPackageSaves,
  threadAgentBindings,
} from "@meridian/database/schema";
import { and, asc, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
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
  PackageSave,
  SaveOwner,
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

  const ownerColumns = (owner: SaveOwner) =>
    "userId" in owner
      ? { userId: owner.userId, projectId: null }
      : { userId: null, projectId: owner.projectId };
  const ownerIs = (owner: SaveOwner) =>
    "userId" in owner
      ? eq(agentPackageSaves.userId, owner.userId)
      : eq(agentPackageSaves.projectId, owner.projectId);
  const saveOf = (
    row: typeof agentPackageSaves.$inferSelect,
    digest: string | null,
    hasPrevious = false,
  ): PackageSave => ({
    id: row.id,
    folder: row.folder,
    packageRevisionId: row.packageRevisionId,
    contentDigest: digest,
    createdAt: row.createdAt,
    undoneSaveId: row.undoneSaveId,
    savedBy: row.savedBy,
    hasPrevious,
  });
  /**
   * The one ordering of a package's Saves and Undos: whoever holds this lock reads the latest row
   * and appends the next, so an Undo's stale check cannot be overtaken by a Save. Held to the end
   * of the transaction, including the first Save and a removal, which have no row to lock.
   */
  const lockPackage = (owner: SaveOwner, folder: string) =>
    db().execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${"userId" in owner ? `user:${owner.userId}` : `project:${owner.projectId}`} ${folder}`}, 0))`,
    );
  const latestOf = async (owner: SaveOwner, folder: string) => {
    const [row] = await db()
      .select()
      .from(agentPackageSaves)
      .where(and(ownerIs(owner), eq(agentPackageSaves.folder, folder)))
      .orderBy(desc(agentPackageSaves.seq))
      .limit(1);
    return row && saveOf(row, await digestOf(row.packageRevisionId));
  };
  const digestOf = async (packageRevisionId: string | null) => {
    if (!packageRevisionId) return null;
    const [row] = await db()
      .select({ digest: agentPackageRevisions.contentDigest })
      .from(agentPackageRevisions)
      .where(eq(agentPackageRevisions.id, packageRevisionId));
    return row.digest;
  };

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
    async settleSave(owner, folder, decide) {
      return runInDrizzleTransaction(database, async () => {
        await lockPackage(owner, folder);
        const latest = await latestOf(owner, folder);
        const { value, publish } = await decide(latest);
        if (!publish) return { value };
        const [row] = await db()
          .insert(agentPackageSaves)
          .values({
            ...ownerColumns(owner),
            folder,
            packageRevisionId: publish.packageRevisionId,
            savedBy: publish.savedBy,
            undoneSaveId: publish.undoneSaveId,
          })
          .returning();
        return { value, row: saveOf(row, await digestOf(row.packageRevisionId), Boolean(latest)) };
      });
    },
    async savePackage(owner, folder, packageRevisionId, metadata) {
      const { row } = await store.settleSave(owner, folder, async () => ({
        value: undefined,
        publish: { packageRevisionId, ...metadata },
      }));
      return row as PackageSave;
    },
    async readSaved(owner) {
      const rows = await db()
        .selectDistinctOn([agentPackageSaves.folder], {
          save: agentPackageSaves,
          digest: agentPackageRevisions.contentDigest,
          hasPrevious: sql<boolean>`lead(${agentPackageSaves.seq}) over (partition by ${agentPackageSaves.folder} order by ${agentPackageSaves.seq} desc) is not null`,
        })
        .from(agentPackageSaves)
        .leftJoin(
          agentPackageRevisions,
          eq(agentPackageRevisions.id, agentPackageSaves.packageRevisionId),
        )
        .where(ownerIs(owner))
        .orderBy(agentPackageSaves.folder, desc(agentPackageSaves.seq));
      const undos = await db()
        .select({ folder: agentPackageSaves.folder, undone: agentPackageSaves.undoneSaveId })
        .from(agentPackageSaves)
        .where(and(ownerIs(owner), isNotNull(agentPackageSaves.undoneSaveId)));
      return rows.map((row) => ({
        ...saveOf(row.save, row.digest, row.hasPrevious),
        undoneSaveIds: undos
          .filter((undo) => undo.folder === row.save.folder)
          .map((undo) => undo.undone as string),
      }));
    },
    async undoSave(owner, saveId, restore) {
      return runInDrizzleTransaction(database, async () => {
        const [target] = await db()
          .select()
          .from(agentPackageSaves)
          .where(and(eq(agentPackageSaves.id, saveId), ownerIs(owner)));
        if (!target) return undefined;
        await lockPackage(owner, target.folder);
        const latest = (await latestOf(owner, target.folder)) as PackageSave;
        const [undo] = await db()
          .select({ id: agentPackageSaves.id })
          .from(agentPackageSaves)
          .where(and(ownerIs(owner), eq(agentPackageSaves.undoneSaveId, saveId)))
          .limit(1);
        if (undo) return { current: latest, undone: null, reason: "already-undone" };
        if (latest.id !== target.id) return { current: latest, undone: null, reason: "later-save" };
        const [before] = await db()
          .select()
          .from(agentPackageSaves)
          .where(
            and(
              ownerIs(owner),
              eq(agentPackageSaves.folder, target.folder),
              lt(agentPackageSaves.seq, target.seq),
            ),
          )
          .orderBy(desc(agentPackageSaves.seq))
          .limit(1);
        if (!before || target.undoneSaveId)
          return { current: latest, undone: null, reason: "not-undoable" };
        const undone = saveOf(target, await digestOf(target.packageRevisionId));
        await restore(undone, saveOf(before, await digestOf(before.packageRevisionId)));
        const current = await store.savePackage(owner, target.folder, before.packageRevisionId, {
          undoneSaveId: saveId,
        });
        return { current, undone };
      });
    },
    async readSavedRevision(userId, projectId, id) {
      const [row] = await db()
        .select({ revision: agentDefinitionRevisions })
        .from(agentDefinitionRevisions)
        .where(
          and(
            eq(agentDefinitionRevisions.id, id),
            sql`exists (select 1 from ${agentPackageSaves} where ${agentPackageSaves.packageRevisionId} = ${agentDefinitionRevisions.packageRevisionId} and (${or(
              eq(agentPackageSaves.userId, userId),
              projectId ? eq(agentPackageSaves.projectId, projectId) : undefined,
            )}))`,
          ),
        );
      return row ? catalogRevision(row.revision) : undefined;
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
    async replaceThreadBinding(threadId, revisionId, configuration, skillPins) {
      const rows = await db()
        .update(threadAgentBindings)
        .set({
          definitionRevisionId: revisionId,
          configuration,
          invokedSkills: sql`${threadAgentBindings.invokedSkills} || ${JSON.stringify(skillPins)}::jsonb`,
        })
        .where(eq(threadAgentBindings.threadId, threadId))
        .returning({ threadId: threadAgentBindings.threadId });
      return rows.length === 1;
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
