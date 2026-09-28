/** Authenticated writer adapter for the paged transcript contract. */

import type { TranscriptPageResponse } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import { createError } from "nitro/h3";
import type { ProjectRepository } from "../domains/projects/index.js";
import {
  InvalidTranscriptCursorError,
  readTranscriptPage,
  requireThreadOwner,
  type ThreadRepositories,
  type ThreadRepository,
  type TranscriptPageInput,
} from "../domains/threads/index.js";
import { toClientSafeBlock } from "../domains/threads/thread-snapshot.js";

export interface ThreadTranscriptRouteDeps {
  repos: Pick<ThreadRepositories, "readSnapshot" | "threads" | "turns" | "blocks">;
  threads: Pick<ThreadRepository, "findById">;
  projects: Pick<ProjectRepository, "findById">;
}

function singleString(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw createError({ statusCode: 400, message: `Invalid ${key}` });
  return value;
}

export function parseTranscriptPageQuery(query: Record<string, unknown>): TranscriptPageInput {
  const order = singleString(query, "order") ?? "newest_first";
  const unit = singleString(query, "unit") ?? "item";
  const range = singleString(query, "range") ?? "effective";
  const rawLimit = singleString(query, "limit");
  const cursor = singleString(query, "cursor");
  if (order !== "newest_first" && order !== "oldest_first") {
    throw createError({ statusCode: 400, message: "Invalid order" });
  }
  if (unit !== "item" && unit !== "turn")
    throw createError({ statusCode: 400, message: "Invalid unit" });
  if (range !== "effective" && range !== "inherited")
    throw createError({ statusCode: 400, message: "Invalid range" });
  const limit =
    rawLimit === undefined ? 40 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw createError({ statusCode: 400, message: "Invalid limit" });
  }
  return {
    order,
    unit,
    range,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export async function handleReadThreadTranscript(
  deps: ThreadTranscriptRouteDeps,
  input: { threadId: string; userId: UserId; query: Record<string, unknown> },
): Promise<TranscriptPageResponse> {
  const pageInput = parseTranscriptPageQuery(input.query);
  const thread = await requireThreadOwner(
    { threads: deps.threads, projects: deps.projects },
    input.threadId,
    input.userId,
  );
  try {
    const page = await readTranscriptPage(deps.repos, thread, pageInput);
    return {
      ...page,
      entries: page.entries.map((entry) => ({
        ...entry,
        blocks: entry.blocks.map(toClientSafeBlock),
      })),
      ...(page.unsettledTail
        ? {
            unsettledTail: page.unsettledTail.map((entry) => ({
              ...entry,
              blocks: entry.blocks.map(toClientSafeBlock),
            })),
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof InvalidTranscriptCursorError) {
      throw createError({ statusCode: 400, message: error.message });
    }
    if (error instanceof RangeError) throw createError({ statusCode: 400, message: error.message });
    throw error;
  }
}
