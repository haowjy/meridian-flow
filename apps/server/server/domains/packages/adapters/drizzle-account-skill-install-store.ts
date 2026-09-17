/** Drizzle AccountSkillInstallStore over `account_skill_installs`. */
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { accountSkillInstalls } from "@meridian/database/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  type AccountSkillInstall,
  AccountSkillInstallConflictError,
  type AccountSkillInstallStore,
} from "../ports/account-skill-install-store.js";

export function createDrizzleAccountSkillInstallStore(db: Database): AccountSkillInstallStore {
  return {
    async insert(input) {
      try {
        const [row] = await db
          .insert(accountSkillInstalls)
          .values({
            ownerUserId: input.ownerUserId,
            slug: input.slug,
            name: input.name,
            description: input.description,
            body: input.body,
          })
          .returning();
        if (!row) throw new Error("Account skill install did not return a row");
        return mapRow(row);
      } catch (cause) {
        if (uniqueOwnerSlug(cause)) throw new AccountSkillInstallConflictError(input.slug);
        throw cause;
      }
    },

    async deleteBySlug(ownerUserId, slug) {
      const deleted = await db
        .delete(accountSkillInstalls)
        .where(
          and(
            eq(accountSkillInstalls.ownerUserId, ownerUserId),
            eq(accountSkillInstalls.slug, slug),
          ),
        )
        .returning({ slug: accountSkillInstalls.slug });
      return deleted.length > 0;
    },

    async listByOwner(ownerUserId) {
      const rows = await db
        .select()
        .from(accountSkillInstalls)
        .where(eq(accountSkillInstalls.ownerUserId, ownerUserId))
        .orderBy(asc(accountSkillInstalls.slug));
      return rows.map(mapRow);
    },
  };
}

function mapRow(row: typeof accountSkillInstalls.$inferSelect): AccountSkillInstall {
  return {
    ownerUserId: row.ownerUserId as UserId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function uniqueOwnerSlug(cause: unknown): boolean {
  let current: unknown = cause;
  while (current) {
    const error = current as { cause?: unknown; code?: unknown };
    if (error.code === "23505") return true;
    current = error.cause;
  }
  return false;
}
