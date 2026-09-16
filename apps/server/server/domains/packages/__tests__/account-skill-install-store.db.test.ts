/** Postgres contracts for account skill install: add-by-slug, unique per owner, delete. */
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { createDrizzleAccountSkillInstallStore } from "../adapters/drizzle-account-skill-install-store.js";
import { createDrizzleAgentRevisionStore } from "../adapters/drizzle-agent-revision-store.js";
import { installPackagedAccountSkill } from "../domain/account-skill-install.js";
import { AccountSkillInstallConflictError } from "../ports/account-skill-install-store.js";

const USER = "00000000-0000-4000-8000-000000000881";
const OTHER = "00000000-0000-4000-8000-000000000882";
const SKILL_BODY = `---
name: story-review
description: Review drafts after prose exists.
---

Story review body.
`;
const url = process.env.DATABASE_URL;

if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  describe.skip("Account skill install store (postgres)", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("Account skill install store (postgres)", () => {
    const db = createDb(url, { max: 4 });
    const agentRevisions = createDrizzleAgentRevisionStore(db);
    const installs = createDrizzleAccountSkillInstallStore(db);

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users, schema.agentPackageRevisions]);
      await db
        .insert(schema.users)
        .values([
          conformanceUserValues(USER, "skill-install-owner"),
          conformanceUserValues(OTHER, "skill-install-other"),
        ]);
      const source = await agentRevisions.installSource({
        coordinate: "meridian-launch-agents",
        files: { "skills/story-review/SKILL.md": SKILL_BODY },
      });
      await agentRevisions.advanceInstallation({
        ownerUserId: null,
        coordinate: "meridian-launch-agents",
        currentRevisionId: source.packageRevisionId,
        upstreamRevisionId: source.packageRevisionId,
        origin: null,
      });
    });
    afterAll(() => db.close());

    it("copies a packaged skill by slug, enforces unique-per-owner, and deletes", async () => {
      const installed = await installPackagedAccountSkill({
        installs,
        agentRevisions,
        ownerUserId: USER,
        slug: "story-review",
      });
      expect(installed).toMatchObject({
        ownerUserId: USER,
        slug: "story-review",
        name: "story-review",
        description: "Review drafts after prose exists.",
        body: "Story review body.\n",
      });
      expect(await installs.listByOwner(USER)).toEqual([installed]);

      await expect(
        installPackagedAccountSkill({
          installs,
          agentRevisions,
          ownerUserId: USER,
          slug: "story-review",
        }),
      ).rejects.toBeInstanceOf(AccountSkillInstallConflictError);

      const other = await installPackagedAccountSkill({
        installs,
        agentRevisions,
        ownerUserId: OTHER,
        slug: "story-review",
      });
      expect(other.ownerUserId).toBe(OTHER);
      expect(await installs.listByOwner(OTHER)).toEqual([other]);

      expect(await installs.deleteBySlug(USER, "story-review")).toBe(true);
      expect(await installs.listByOwner(USER)).toEqual([]);
      expect(await installs.deleteBySlug(USER, "story-review")).toBe(false);
      expect(await installs.listByOwner(OTHER)).toEqual([other]);
    });
  });
}
