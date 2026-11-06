/**
 * The `search` → `grep` rename over rows written before it: every stored place that named the
 * tool, the `prompt_bakes` rewrite through its insert-only trigger, and re-running.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the trigger is never disabled; it passes updates only while a session setting is on, and is restored
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { assertThrowawayDatabaseForRunDbTests } from "../__test-support__/db-fixtures";
import { migrate } from "./0107_grep_tool_rename";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

describe.skipIf(!runDbTests || !databaseUrl)("0107 grep tool rename", () => {
  it("renames every stored place, keeps the bake trigger, and is re-runnable", async () => {
    assertThrowawayDatabaseForRunDbTests(databaseUrl ?? "");
    const sql = postgres(databaseUrl ?? "", { max: 1 });
    const session = await sql.reserve();
    const id = () => randomUUID();
    const [thread, turn, packageRevision, binding] = [id(), id(), id(), id()];
    try {
      // The parents of these rows are beside the point; the rename touches only the rows below.
      await session`SET session_replication_role = replica`;
      const block = (blockType: string, sequence: number, content: object) =>
        session`INSERT INTO turn_blocks (id, turn_id, block_type, sequence, content)
          VALUES (${id()}, ${turn}, ${blockType}, ${sequence}, ${session.json(content as never)})`;
      // A batch boundary: more rows than one batch (500) carry the old name.
      for (let n = 0; n < 502; n += 1) {
        await block("tool_use", n, {
          toolCallId: `c${n}`,
          toolName: "search",
          input: { pattern: n === 0 ? "a.b\\_c (x)" : "Lin", scope: "kb://" },
        });
      }
      // A result block names its call by id only.
      await block("tool_result", 1000, {
        toolCallId: "c0",
        output: "text",
        result: [{ uri: "kb://a", matches: [{ excerpt: "x" }], matchCount: 1 }],
      });
      await block("tool_use", 1001, {
        toolCallId: "r",
        toolName: "read",
        input: { path: "kb://a" },
      });
      await session`INSERT INTO prompt_bakes (id, owner_thread_id, composed_system_prompt, baked_skill_slugs, baked_tools, content_hash)
        VALUES (${id()}, ${thread}, 'p', '[]'::jsonb, ${session.json([
          { type: "function", name: "read", description: "Read.", inputSchema: {} },
          { type: "function", name: "search", description: "old", inputSchema: {} },
          {
            type: "function",
            name: "thread_history",
            description: "hides `search` calls",
            inputSchema: {},
          },
        ] as never)}, 'h')`;
      await session`INSERT INTO agent_definition_revisions (id, package_revision_id, slug, definition, definition_digest)
        VALUES (${id()}, ${packageRevision}, 'a', ${session.json({
          metadata: { tools: ["read", "search"], "disallowed-tools": ["search", "grep"] },
        })}, 'd')`;
      await session`INSERT INTO thread_agent_bindings (thread_id, configuration, invocation_overlay)
        VALUES (${binding}, ${session.json({ tools: ["read", "search"], "disallowed-tools": [] })},
          ${session.json({ overrides: { "disallowed-tools": ["search"] } })})`;
      await session`INSERT INTO thread_run_leases (thread_id, execution_id, holder_id, expires_at, current_tool)
        VALUES (${thread}, 'e', 'h', now() + interval '1 hour', ${session.json({
          toolCallId: "c",
          toolName: "search",
          input: {},
        })})`;
      await session`SET session_replication_role = DEFAULT`;

      await migrate(session);
      await migrate(session);

      const [uses] = await session`SELECT count(*)::int AS n FROM turn_blocks
        WHERE content->>'toolName' = 'search' OR content->>'toolName' = 'grep' AND content->'input' ? 'scope'`;
      expect(uses?.n).toBe(0);
      const [first] =
        await session`SELECT content FROM turn_blocks WHERE content->>'toolCallId' = 'c0' AND block_type = 'tool_use'`;
      // Decoded as `search` compared it, then escaped; the case-insensitivity it had is kept.
      expect(first?.content).toMatchObject({
        toolName: "grep",
        input: { pattern: "a\\.b_c \\(x\\)", path: "kb://", "-i": true },
      });
      const [result] =
        await session`SELECT content FROM turn_blocks WHERE block_type = 'tool_result'`;
      expect(result?.content).toMatchObject({
        output: "text",
        result: { files: [{ uri: "kb://a" }], totalFiles: 1, exact: true },
      });
      const [read] =
        await session`SELECT content FROM turn_blocks WHERE content->>'toolName' = 'read'`;
      expect(read?.content).toEqual({
        toolCallId: "r",
        toolName: "read",
        input: { path: "kb://a" },
      });

      const [bake] =
        await session`SELECT baked_tools AS tools FROM prompt_bakes WHERE owner_thread_id = ${thread}`;
      const tools = bake?.tools as Array<{ name: string; description: string }>;
      expect(tools.map((tool) => tool.name)).toEqual(["read", "grep", "thread_history"]);
      expect(tools[2]?.description).toBe("hides `grep` calls");
      const [revision] =
        await session`SELECT definition FROM agent_definition_revisions WHERE package_revision_id = ${packageRevision}`;
      expect(revision?.definition).toEqual({
        metadata: { tools: ["read", "grep"], "disallowed-tools": ["grep"] },
      });
      const [bound] =
        await session`SELECT configuration, invocation_overlay AS overlay FROM thread_agent_bindings WHERE thread_id = ${binding}`;
      expect(bound?.configuration).toEqual({ tools: ["read", "grep"], "disallowed-tools": [] });
      expect(bound?.overlay).toEqual({ overrides: { "disallowed-tools": ["grep"] } });
      const [lease] =
        await session`SELECT current_tool->>'toolName' AS name FROM thread_run_leases WHERE thread_id = ${thread}`;
      expect(lease?.name).toBe("grep");

      // The trigger is back: a plain update of a bake is still refused.
      await expect(
        session`UPDATE prompt_bakes SET content_hash = 'x' WHERE owner_thread_id = ${thread}`,
      ).rejects.toThrow(/insert-only/);
    } finally {
      await session`SET session_replication_role = replica`;
      await session`DELETE FROM prompt_bakes WHERE owner_thread_id = ${thread}`;
      await session`DELETE FROM turn_blocks WHERE turn_id = ${turn}`;
      await session`DELETE FROM agent_definition_revisions WHERE package_revision_id = ${packageRevision}`;
      await session`DELETE FROM thread_agent_bindings WHERE thread_id = ${binding}`;
      await session`DELETE FROM thread_run_leases WHERE thread_id = ${thread}`;
      await session`SET session_replication_role = origin`;
      session.release();
      await sql.end();
    }
  });
});
