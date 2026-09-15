/** Bounded HTTP pagination over account/system Agent catalog identities. */
import type { AgentCatalogCursor } from "@meridian/contracts/agents";
import { createError } from "nitro/h3";
import { requireRequestId } from "./request-id.js";

export function parseAgentCatalogQuery(query: Record<string, unknown>): {
  limit: number;
  after?: AgentCatalogCursor;
} {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (
    (query.limit !== undefined && typeof query.limit !== "string") ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw createError({
      statusCode: 400,
      message: "Agent catalog limit must be between 1 and 100",
    });
  }
  if (query.afterId === undefined && query.afterNameSortKey === undefined) return { limit };
  if (typeof query.afterNameSortKey !== "string")
    throw createError({ statusCode: 400, message: "afterNameSortKey is required with afterId" });
  return {
    limit,
    after: { id: requireRequestId(query.afterId, "afterId"), nameSortKey: query.afterNameSortKey },
  };
}
