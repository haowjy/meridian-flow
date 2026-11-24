/**
 * An agent write that reaches the journal is refused there unless a bound
 * grant covers the document it writes.
 */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, projects, threads, turns, users } from "@meridian/database/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  requireAgentWriteGrant,
  UngrantedAgentWriteError,
} from "../../shared/edit-confirmation.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../test-support/tree-seed.js";
import { insertWorks } from "../../test-support/work-rows.js";
import {
  type AgentChain,
  createDrizzleFileFacts,
  createFileAccess,
  createOwnerFileGrants,
  type FileGrant,
  type FileTarget,
  isFileAccessDenied,
  type Principal,
  runWithEditGrants,
} from "./index.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("agent journal writes need a covering grant (postgres)", () => {});
} else {
  describe("agent journal writes need a covering grant (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000b00";
    const p = "00000000-0000-4000-8000-000000000b01";
    const w = "00000000-0000-4000-8000-000000000b02";
    const source = "00000000-0000-4000-8000-000000000b03";
    const probe = "00000000-0000-4000-8000-000000000b04";
    const turn = "00000000-0000-4000-8000-000000000b05";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    const chain: AgentChain = [
      {
        threadId: "thread",
        permission: "edit",
        threadWorkId: w,
        scratchOwner: { scope: "work", workId: w },
      },
    ];
    const agent: Principal = {
      accountId: u,
      agent: {
        projectId: p as never,
        chain,
        draftOwner: { owner: { kind: "work", workId: w }, draftId: "fileaccessw1", handle: null },
        writeMode: "direct",
      },
    };

    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "agent-journal-grant"));
      await db.insert(projects).values({ id: p, userId: u, name: "Probe", slug: "probe" });
      await insertWorks(db, {
        id: w,
        projectId: p,
        createdByUserId: u,
        name: "Archived scratch probe",
        handle: "w1",
        draftId: "fileaccessw1",
      });
      await db
        .insert(contextSources)
        .values({ id: source, workId: w, scope: "work", slug: "scratch" });
      await treeSeeder(db).document(source, "probe", { id: probe });
    });

    const access = () =>
      createFileAccess({
        facts: createDrizzleFileFacts(database.current),
        grants: createOwnerFileGrants(),
        readAgentChain: async () => chain,
      });

    it("refuses an agent's write that carries no grant", async () => {
      await expect(requireAgentWriteGrant([probe])).rejects.toBeInstanceOf(
        UngrantedAgentWriteError,
      );
    });

    it("refuses an agent's write its bound grants don't cover", async () => {
      const kbSource = "00000000-0000-4000-8000-000000000b06";
      await database.current
        .insert(contextSources)
        .values({ id: kbSource, projectId: p, scope: "project", slug: "kb" });
      const thread = "00000000-0000-4000-8000-000000000b07";
      await database.current.insert(threads).values({
        rootThreadId: thread,
        id: thread,
        projectId: p,
        createdByUserId: u,
        title: "Thread",
        kind: "primary",
      });
      await database.current.insert(turns).values({
        id: turn,
        threadId: thread,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const containerGrant = async (target: FileTarget) => {
        const grant = await access().authorize(agent, target, "edit");
        if (isFileAccessDenied(grant)) throw new Error(`Denied: ${grant.reason}`);
        return grant;
      };
      const appendUnder = (grant: FileGrant<"edit">) =>
        runWithEditGrants(access(), [grant], () => requireAgentWriteGrant([probe]));

      // A create's grant in the knowledge base doesn't reach a scratch file.
      const kb = await containerGrant({
        kind: "container",
        scheme: "kb",
        owner: { scope: "project", projectId: p },
      });
      await expect(appendUnder(kb)).rejects.toBeInstanceOf(UngrantedAgentWriteError);
      const scratch = await containerGrant({
        kind: "container",
        scheme: "scratch",
        owner: { scope: "work", workId: w },
      });
      await expect(appendUnder(scratch)).resolves.toMatchObject({ ok: true });
    });
  });
}
