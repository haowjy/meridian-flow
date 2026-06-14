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
  async create(input: CreateProjectResultInput): Promise<ProjectResultRecord> {
    const [row] = await this.db
      .insert(projectResults)
      .values({
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
      .returning();
    if (!row) throw new Error("Failed to insert project result");
    return mapRow(row);
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
