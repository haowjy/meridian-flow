/**
 * Postgres guard on MCP pins: a pin is never edited or deleted on its own, only with its connection.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a re-pin is a new row, because a thread's bake holds the pin id it started with
 */
import type { UserId } from "@meridian/contracts/runtime";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { mcpConnections, mcpPins, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useRollbackTestDatabase } from "../../../../test-support/drizzle-reset.js";
import { createDrizzleConnectionStore } from "./connection-store.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("mcp pins (postgres)", () => {});
else
  describe("mcp pins (postgres)", () => {
    const database = useRollbackTestDatabase(DATABASE_URL);
    const accountId = "00000000-0000-4000-8000-000000000862" as UserId;
    const pin = {
      format: 1 as const,
      server: { name: "s", version: "1", protocolVersion: "2025-03-26" },
      pinnedAt: "2026-01-01T00:00:00.000Z",
      tools: [],
    };

    beforeEach(async () => {
      await database.current.insert(users).values(conformanceUserValues(accountId, "mcp-pins"));
    });

    it("rejects an update or a delete of a pin, and lets its connection's delete take it", async () => {
      const db = database.current;
      const store = createDrizzleConnectionStore({ db });
      const added = await store.add({
        id: "00000000-0000-4000-8000-0000000008a1",
        accountId,
        projectId: null,
        name: "notes",
        spec: { transport: "http", url: "https://example.com/mcp" },
        sealedToken: null,
      });
      const saved = await store.savePin(added.row.id, pin, "hash");

      await expect(
        db.transaction((tx) =>
          tx.update(mcpPins).set({ pinHash: "other" }).where(eq(mcpPins.id, saved.id)),
        ),
      ).rejects.toMatchObject({ cause: { message: "MCP pins are insert-only" } });
      await expect(
        db.transaction((tx) => tx.delete(mcpPins).where(eq(mcpPins.id, saved.id))),
      ).rejects.toMatchObject({ cause: { message: "MCP pins are insert-only" } });

      await db.delete(mcpConnections).where(eq(mcpConnections.id, added.row.id));
      expect(await db.select().from(mcpPins).where(eq(mcpPins.id, saved.id))).toEqual([]);
    });
  });
