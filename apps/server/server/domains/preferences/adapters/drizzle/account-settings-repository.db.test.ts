/** Postgres account JSONB patches and retirement preserve independent preferences. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { UserId } from "@meridian/contracts/runtime";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { userPreferences, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { useRollbackTestDatabase } from "../../../../test-support/drizzle-reset.js";
import { createDrizzleAccountSettingsRepository } from "./account-settings-repository.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("account settings (postgres)", () => {});
else
  describe("account settings (postgres)", () => {
    const database = useRollbackTestDatabase(DATABASE_URL);
    const id = "00000000-0000-4000-8000-000000000861" as UserId;
    beforeEach(async () => {
      await database.current.insert(users).values(conformanceUserValues(id, "account-settings"));
    });
    it("stores partial patches in JSONB without losing unrelated fields or sync", async () => {
      const db = database.current;
      const repository = createDrizzleAccountSettingsRepository({ db });
      expect(await repository.read(id)).toEqual({
        ...DEFAULT_ACCOUNT_APPEARANCE,
        workingSetSyncEnabled: true,
      });
      await repository.update(id, { theme: "dark" });
      await repository.update(id, {
        language: "zh",
        statsForNerds: true,
        workingSetSyncEnabled: false,
      });
      expect(await repository.read(id)).toEqual({
        theme: "dark",
        language: "zh",
        statsForNerds: true,
        workingSetSyncEnabled: false,
      });
      const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, id));
      expect(row?.preferences).toEqual({ theme: "dark", language: "zh", statsForNerds: true });
    });
  });
