/** Atomic account preference patches, preserving independent JSONB fields. */
import { DEFAULT_ACCOUNT_APPEARANCE } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { userPreferences, users } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../../shared/drizzle-transaction.js";
import type { AccountSettingsRepository } from "../../ports/account-settings-repository.js";
export function createDrizzleAccountSettingsRepository({
  db,
}: {
  db: Database;
}): AccountSettingsRepository {
  async function read(
    userId: Parameters<AccountSettingsRepository["read"]>[0],
    connection: DrizzleDb = db,
  ): Promise<AccountSettings> {
    const [row] = await connection
      .select({ preferences: userPreferences.preferences, enabled: users.workingSetSyncEnabled })
      .from(users)
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(eq(users.id, userId));
    if (!row) throw new Error("Authenticated account not found");
    return {
      ...DEFAULT_ACCOUNT_APPEARANCE,
      ...row.preferences,
      workingSetSyncEnabled: row.enabled,
    };
  }
  return {
    read,
    async update(userId, patch) {
      return db.transaction(async (tx) => {
        // One account lock orders both preference homes and their returned snapshot.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
        const { workingSetSyncEnabled, ...appearance } = patch;
        if (workingSetSyncEnabled !== undefined) {
          await tx
            .update(users)
            .set({ workingSetSyncEnabled, updatedAt: new Date().toISOString() })
            .where(eq(users.id, userId));
        }
        if (Object.keys(appearance).length) {
          await tx
            .insert(userPreferences)
            .values({ userId, preferences: appearance })
            .onConflictDoUpdate({
              target: userPreferences.userId,
              set: {
                preferences: sql`${userPreferences.preferences} || ${JSON.stringify(appearance)}::jsonb`,
                updatedAt: new Date(),
              },
            });
        }
        return read(userId, tx);
      });
    },
  };
}
