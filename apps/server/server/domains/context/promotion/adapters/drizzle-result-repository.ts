import type { ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projectResults } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../../shared/thread-work-lock.js";
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
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export class DrizzleResultRepository implements ResultRepository {
  constructor(private readonly db: Database) {}
  async createOrConverge(input: CreateProjectResultInput) {
    return runInDrizzleTransaction(this.db, async () => {
      const activeDb = currentDrizzleDb(this.db);
      let threadUnavailable = false;
      const threadIds = [
        ...new Set([input.provenance.rootThreadId, input.provenance.threadId]),
      ].sort();
      for (const threadId of threadIds) {
        const thread = await lockThreadForMutation(this.db, threadId as ThreadId);
        if (!thread || thread.deletedAt || thread.projectId !== input.projectId) {
          threadUnavailable = true;
        }
      }

      const [existing] = await activeDb
        .select()
        .from(projectResults)
        .where(eq(projectResults.id, input.id))
        .limit(1);
      if (!existing && threadUnavailable) {
        return {
          kind: "definitely_not_committed" as const,
          error: "Thread is no longer available",
        };
      }

      if (!existing) {
        await activeDb
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
          })
          .onConflictDoNothing();
      }

      const [row] = await activeDb
        .select()
        .from(projectResults)
        .where(eq(projectResults.id, input.id))
        .limit(1);
      if (!row || row.deletedByWorkId || threadUnavailable) {
        return { kind: "unknown" as const, error: "Result outcome remains unknown" };
      }
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
    });
  }
}
export function createDrizzleResultRepository(db: Database): ResultRepository {
  return new DrizzleResultRepository(db);
}
