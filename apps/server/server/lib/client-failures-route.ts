/** Authenticated metadata ingest, with bounded process-local deduplication and per-account admission. */
import { clientFailureBatchSchema, clientFailureEvent } from "@meridian/contracts/failures";
import { createError } from "nitro/h3";
import type { EventSink } from "../domains/observability/index.js";
import { requireThreadOwner } from "../domains/threads/index.js";
import type { ThreadRepositories } from "./compose.js";

const seen = new Map<string, number>();
const rates = new Map<string, { since: number; count: number }>();
const WINDOW_MS = 60_000;

export async function ingestClientFailures(
  deps: {
    threads: ThreadRepositories["threads"];
    turns: ThreadRepositories["turns"];
    sink: EventSink;
  },
  userId: string,
  body: unknown,
): Promise<{ accepted: number }> {
  const parsed = clientFailureBatchSchema.safeParse(body);
  if (!parsed.success) throw createError({ statusCode: 400, message: "Invalid failure batch" });
  if (parsed.data.accountId !== userId)
    throw createError({ statusCode: 403, message: "Account changed" });
  const now = Date.now();
  const rate = rates.get(userId);
  const current = rate && now - rate.since < WINDOW_MS ? rate : { since: now, count: 0 };
  if (current.count + parsed.data.records.length > 256)
    throw createError({ statusCode: 429, message: "Too many failure records" });
  current.count += parsed.data.records.length;
  rates.set(userId, current);
  if (rates.size > 1000) rates.delete(rates.keys().next().value as string);
  for (const threadId of new Set(
    parsed.data.records.flatMap((r) => (r.threadId ? [r.threadId] : [])),
  ))
    await requireThreadOwner({ threads: deps.threads }, threadId, userId);
  let accepted = 0;
  for (const record of parsed.data.records) {
    const key = `${userId}:${record.occurrenceId}:${record.phase}`;
    const at = seen.get(key);
    if (at !== undefined && now - at < 5 * WINDOW_MS) continue;
    seen.set(key, now);
    if (seen.size > 5000) seen.delete(seen.keys().next().value as string);
    let turnId: string | undefined;
    if (record.turnId && record.threadId) {
      const turn = await deps.turns.findById(record.turnId as never);
      if (turn?.threadId === record.threadId) turnId = record.turnId;
    }
    deps.sink.emit(clientFailureEvent({ ...record, turnId }));
    accepted += 1;
  }
  return { accepted };
}
