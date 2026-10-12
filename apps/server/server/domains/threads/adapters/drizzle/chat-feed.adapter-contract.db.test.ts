/** Drizzle half of the shared chat-feed repository conformance suite. */
import { beforeEach, describe, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle chat feed adapter contract (postgres)", () => {});
} else {
  describe("drizzle chat feed adapter contract (postgres)", async () => {
    const { projects, users, works } = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../../../test-support/drizzle-reset.js"
    );
    const { createDrizzleRepositoriesForTest } = await import("./repositories.js");
    const {
      expectChatFeedCursorAcrossFilterContract,
      expectChatFeedSearchSemanticsContract,
      expectChatFeedWorkFilterContract,
    } = await import("../__conformance__/chat-feed-contract.js");

    const USER_ID = "00000000-0000-4000-8000-000000000901";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000902";

    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(users).values(conformanceUserValues(USER_ID, "chat-feed-contract"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Chat Feed Contract",
        slug: "chat-feed-contract",
      });
    });

    function harness() {
      let workCounter = 0;
      return {
        repos: createDrizzleRepositoriesForTest(db),
        projectId: PROJECT_ID,
        userId: USER_ID,
        async createWork() {
          workCounter += 1;
          const id = `00000000-0000-4000-8000-0000000009${String(10 + workCounter).padStart(2, "0")}`;
          await db.insert(works).values({
            id,
            projectId: PROJECT_ID,
            createdByUserId: USER_ID,
            name: `Contract Work ${workCounter}`,
            slug: `contract-work-${workCounter}`,
          });
          return id;
        },
      };
    }

    it("matches search metacharacters literally, CJK, and case-folded", async () => {
      await expectChatFeedSearchSemanticsContract(harness());
    });

    it("pages a cursor minted under a filter using that same filter", async () => {
      await expectChatFeedCursorAcrossFilterContract(harness());
    });

    it("composes Work membership with search, Favorites, and cursor pagination", async () => {
      await expectChatFeedWorkFilterContract(harness());
    });
  });
}
