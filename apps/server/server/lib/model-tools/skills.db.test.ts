/**
 * A user-invoked skill's files (D64) on Postgres: the invocation pins the
 * skill on the thread's binding, so the wired `read`, `ls` and `skill` see it
 * on a General thread that doesn't name it, and a spawned child doesn't.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Thread } from "@meridian/contracts/threads";
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import {
  type AgentSourceSnapshot,
  createDrizzleAgentRevisionStore,
  createInMemoryAccountSkillInstallStore,
  resolveAgentConfiguration,
} from "../../domains/packages/index.js";
import { createToolExecutor, createToolRegistry } from "../../domains/runtime/index.js";
import { loadUserSkillBody } from "../../domains/runtime/loop/available-skills.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createModelToolRegistrations, type ToolWiringDeps } from "./index.js";

const USER = "00000000-0000-4000-8000-000000000981";
const PROJECT = "00000000-0000-4000-8000-000000000982";
const PARENT = "00000000-0000-4000-8000-000000000983";
const CHILD = "00000000-0000-4000-8000-000000000984";
const SPAWN_TURN = "00000000-0000-4000-8000-000000000985";
const LAUNCH_AGENTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../domains/packages/builtin/launch-agents",
);
const RESOURCE = "skills://story-review/resources/line-edit.md";
const url = process.env.DATABASE_URL;

async function launchAgentsSource(): Promise<AgentSourceSnapshot> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(LAUNCH_AGENTS, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "mars.toml") continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files[path.relative(LAUNCH_AGENTS, absolute)] = await readFile(absolute, "utf8");
  }
  return { coordinate: "meridian-launch-agents", files };
}

if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  describe.skip("user-invoked skills (postgres)", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("user-invoked skills (postgres)", () => {
    const db = createDb(url, { max: 4 });
    const agentRevisions = createDrizzleAgentRevisionStore(db);
    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users, schema.agentPackageRevisions]);
      await db.insert(schema.users).values(conformanceUserValues(USER, "skill-invoker"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Skills", slug: "skills" });
      await db
        .insert(schema.threads)
        .values({ id: PARENT, rootThreadId: PARENT, projectId: PROJECT, createdByUserId: USER });
      await db.insert(schema.turns).values({
        id: SPAWN_TURN,
        threadId: PARENT,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      await db.insert(schema.threads).values({
        id: CHILD,
        rootThreadId: PARENT,
        parentThreadId: PARENT,
        kind: "subagent",
        originType: "spawn",
        originTurnId: SPAWN_TURN,
        spawnStatus: "running",
        spawnDepth: 1,
        projectId: PROJECT,
        createdByUserId: USER,
      });
    });
    afterAll(() => db.close());

    it("lets the thread read a skill its user invoked, and not a spawned child", async () => {
      const launch = await agentRevisions.installSource(await launchAgentsSource());
      await agentRevisions.advanceInstallation({
        ownerUserId: null,
        coordinate: "meridian-launch-agents",
        currentRevisionId: launch.packageRevisionId,
        upstreamRevisionId: launch.packageRevisionId,
        origin: null,
      });
      const general = (
        await agentRevisions.installSource({
          coordinate: "meridian/general",
          files: { "agents/general.md": "---\nname: General\nmodel: fixture-model\n---\n\n" },
        })
      ).definitions[0];
      if (!general) throw new Error("General definition missing");
      const configuration = await resolveAgentConfiguration({
        revision: general,
        store: agentRevisions,
        defaultModel: "fixture-model",
      });
      await agentRevisions.bindThread(PARENT, general.id, configuration, null);
      await agentRevisions.bindThread(CHILD, null, configuration, null);

      const deps = {
        threads: { findById: async (id: string) => ({ id, userId: USER }) },
        readAgentChain: async (threadId: string) => [
          { threadId, permission: "edit", threadWorkId: "work-1" },
        ],
        readChainPermission: async () => "edit",
        fileAccess: createAllowAllFileAccess(),
        agentRevisions,
      } as unknown as ToolWiringDeps;
      const executor = createToolExecutor(
        createToolRegistry({ registrations: createModelToolRegistrations(deps) }),
      );
      const call = async (threadId: string, name: string, input: Record<string, unknown>) =>
        (
          await executor.executeTool({ id: "call-1", name, arguments: input }, {
            threadId,
            turnId: "turn-1",
          } as never)
        ).output;
      expect(await call(PARENT, "ls", { path: "skills://" })).toBe("skills://\n  (empty)");

      const body = await loadUserSkillBody({
        thread: { id: PARENT, userId: USER, kind: "primary" } as Thread,
        slug: "story-review",
        agentRevisions,
        accountSkillInstalls: createInMemoryAccountSkillInstallStore(),
      });
      expect(body.readable).toBe(true);

      expect(await call(PARENT, "read", { path: RESOURCE })).toMatch(
        /^skills:\/\/story-review\/resources\/line-edit\.md\nPaths in this skill are relative to skills:\/\/story-review\/\.\n\n/,
      );
      expect(await call(PARENT, "ls", { path: "skills://" })).toBe(
        "skills://\n  story-review/ (read-only)",
      );
      expect(await call(PARENT, "skill", { name: "story-review" })).toMatch(
        /^skills:\/\/story-review\/SKILL\.md\nPaths in this skill are relative/,
      );

      expect(await call(CHILD, "read", { path: RESOURCE })).toBe(
        `status: document_not_found; path: ${RESOURCE}\n\nFile not found. Check the path with \`ls\`.`,
      );
      expect(await call(CHILD, "skill", { name: "story-review" })).toBe(
        'Skill "story-review" isn\'t available. This agent has no skills. (not_found)',
      );
    });
  });
}
