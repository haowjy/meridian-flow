/**
 * Drizzle UsageRecorder: records a model response and recomputes turn/thread
 * rollups from persisted response rows. Retained for direct callers while
 * matching the projector's replay-idempotent aggregate semantics.
 */
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type {
  RecordModelResponseUsageInput,
  RecordModelResponseUsageResult,
  UsageRecorder,
} from "../../ports/repositories.js";
import { mapTurn } from "./mappers.js";
import { writeModelResponse } from "./model-response-repository.js";
import { currentDrizzleDb, type DrizzleDatabase, type DrizzleDb } from "./repositories.js";
import { writeThreadCostRecompute } from "./thread-repository.js";
import { writeTurnRollupRecompute } from "./turn-repository.js";

async function recordModelResponseUsageInDb(
  db: DrizzleDb,
  input: RecordModelResponseUsageInput,
): Promise<RecordModelResponseUsageResult> {
  const modelResponseResult = await writeModelResponse(db, input.response);
  if (!modelResponseResult.inserted) {
    const [turn] = await currentDrizzleDb(db)
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.id, input.response.turnId));
    if (!turn) throw new Error(`Turn not found: ${input.response.turnId}`);
    return { modelResponse: modelResponseResult.row, turn: mapTurn(turn) };
  }
  const turn = await writeTurnRollupRecompute(db, input.response.turnId);
  await writeThreadCostRecompute(db, turn.threadId);
  return { modelResponse: modelResponseResult.row, turn };
}

export function createDrizzleUsageRecorder(db: DrizzleDatabase): UsageRecorder {
  return {
    async recordModelResponseUsage(input) {
      const activeDb = currentDrizzleDb(db);
      if (activeDb !== db) {
        return recordModelResponseUsageInDb(activeDb, input);
      }
      return db.transaction(async (tx) => {
        return recordModelResponseUsageInDb(tx, input);
      });
    },
  };
}
