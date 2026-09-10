import type { Database } from "@meridian/database";
import { projectResults } from "@meridian/database/schema";
import { desc, eq } from "drizzle-orm";
import type {
  CreateProjectResultInput,
  ProjectResultRecord,
  ResultRepository,
} from "../ports/result-repository.js";

function mapRow(row: typeof projectResults.$inferSelect): ProjectResultRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    sourcePath: row.sourcePath,
    resultsUri: row.resultsUri,
    storageUrl: row.storageUrl,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    provenance: {
      rootThreadId: row.rootThreadId,
      threadId: row.threadId,
      turnId: row.turnId,
      toolCallId: row.toolCallId,
      agentSlug: row.agentSlug,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleResultRepository implements ResultRepository {
  constructor(private readonly db: Database) {}
  async createOrConverge(input: CreateProjectResultInput) {
    const insert = () =>
      this.db
        .insert(projectResults)
        .values({
          id: input.id,
          projectId: input.projectId,
          sourcePath: input.sourcePath,
          resultsUri: input.resultsUri,
          storageUrl: input.storageUrl,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          rootThreadId: input.provenance.rootThreadId,
          threadId: input.provenance.threadId,
          turnId: input.provenance.turnId,
          toolCallId: input.provenance.toolCallId,
          agentSlug: input.provenance.agentSlug,
        })
        .onConflictDoNothing()
        .returning();
    try {
      await insert();
    } catch {
      // Retrying the identical caller-owned ID is the reconciliation boundary.
      try {
        await insert();
      } catch (cause) {
        return {
          kind: "unknown" as const,
          error: cause instanceof Error ? cause.message : "Result reconciliation failed",
        };
      }
    }
    const [row] = await this.db
      .select()
      .from(projectResults)
      .where(eq(projectResults.id, input.id))
      .limit(1);
    if (!row) return { kind: "unknown" as const, error: "Result outcome remains unknown" };
    const record = mapRow(row);
    const exact =
      record.projectId === input.projectId &&
      record.sourcePath === input.sourcePath &&
      record.resultsUri === input.resultsUri &&
      record.storageUrl === input.storageUrl &&
      record.mimeType === input.mimeType &&
      record.sizeBytes === input.sizeBytes &&
      JSON.stringify(record.provenance) === JSON.stringify(input.provenance);
    return exact
      ? { kind: "committed" as const, record }
      : { kind: "unknown" as const, error: "Result ID already has different payload" };
  }
  async listByProject(projectId: string): Promise<ProjectResultRecord[]> {
    const rows = await this.db
      .select()
      .from(projectResults)
      .where(eq(projectResults.projectId, projectId))
      .orderBy(desc(projectResults.createdAt));
    return rows.map(mapRow);
  }
}
export function createDrizzleResultRepository(db: Database): ResultRepository {
  return new DrizzleResultRepository(db);
}
