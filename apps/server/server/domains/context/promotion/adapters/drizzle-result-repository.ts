import type { Database } from "@meridian/database";
import { workbenchResults } from "@meridian/database/schema";
import { desc, eq } from "drizzle-orm";
import type {
  CreateWorkbenchResultInput,
  ResultRepository,
  WorkbenchResultRecord,
} from "../ports/result-repository.js";

function mapRow(row: typeof workbenchResults.$inferSelect): WorkbenchResultRecord {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
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
  async create(input: CreateWorkbenchResultInput): Promise<WorkbenchResultRecord> {
    const [row] = await this.db
      .insert(workbenchResults)
      .values({
        workbenchId: input.workbenchId,
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
    if (!row) throw new Error("Failed to insert workbench result");
    return mapRow(row);
  }
  async listByWorkbench(workbenchId: string): Promise<WorkbenchResultRecord[]> {
    const rows = await this.db
      .select()
      .from(workbenchResults)
      .where(eq(workbenchResults.workbenchId, workbenchId))
      .orderBy(desc(workbenchResults.createdAt));
    return rows.map(mapRow);
  }
}
export function createDrizzleResultRepository(db: Database): ResultRepository {
  return new DrizzleResultRepository(db);
}
