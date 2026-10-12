/** Fixtures for repairing pre-contract saved chat shapes across migrations 0009 and 0014. */
import { readFile } from "node:fs/promises";
import { parseInvocationCard } from "@meridian/contracts/components";
import type { JsonValue } from "@meridian/contracts/threads";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!enabled || !databaseUrl) {
  describe.skip("saved subagent contract migration (postgres)", () => {});
} else {
  describe("saved subagent contract migration (postgres)", () => {
    it("repairs each legacy card and notification shape and removes unresolvable notices", async () => {
      const migration = await readFile(
        new URL("./migrations/0009_repair_saved_subagent_contracts.sql", import.meta.url),
        "utf8",
      );
      const lineageRepair = await readFile(
        new URL("./migrations/0014_threads_origin_turn_fk.sql", import.meta.url),
        "utf8",
      );
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          await tx.unsafe(`
						CREATE TEMP TABLE threads (
							id uuid PRIMARY KEY,
							parent_thread_id uuid,
							root_thread_id uuid,
							origin_turn_id uuid,
							origin_type text,
							ref text,
							kind text DEFAULT 'primary' NOT NULL,
							spawn_status text,
							spawn_depth integer DEFAULT 0 NOT NULL,
							active_leaf_turn_id uuid,
							conversational_leaf_turn_id uuid,
							CONSTRAINT threads_organic_origin_fields_empty
								CHECK (origin_type IS NOT NULL OR (parent_thread_id IS NULL AND origin_turn_id IS NULL AND spawn_status IS NULL)),
							CONSTRAINT threads_spawn_depth_nonneg CHECK (spawn_depth >= 0)
						) ON COMMIT DROP;
						CREATE TEMP TABLE thread_agent_bindings (thread_id uuid, definition_revision_id uuid) ON COMMIT DROP;
						CREATE TEMP TABLE agent_definition_revisions (id uuid PRIMARY KEY, slug text, definition jsonb) ON COMMIT DROP;
						CREATE TEMP TABLE thread_execution_reports (assistant_turn_id uuid, child_thread_id uuid, outcome text, agent_slug text, created_at timestamptz DEFAULT now()) ON COMMIT DROP;
						CREATE TEMP TABLE turns (id uuid PRIMARY KEY, thread_id uuid, parent_turn_id uuid, role text, metadata jsonb) ON COMMIT DROP;
						CREATE TEMP TABLE turn_blocks (id uuid PRIMARY KEY, turn_id uuid, block_type text, content jsonb, created_at timestamptz) ON COMMIT DROP;
						CREATE TEMP TABLE event_journal (turn_id uuid) ON COMMIT DROP;
					`);

          const root = "10000000-0000-4000-8000-000000000001";
          const childOne = "10000000-0000-4000-8000-000000000002";
          const childTwo = "10000000-0000-4000-8000-000000000003";
          const revisionOne = "20000000-0000-4000-8000-000000000001";
          const revisionTwo = "20000000-0000-4000-8000-000000000002";
          const launchTurn = "30000000-0000-4000-8000-000000000001";
          const missingStartedTurn = "30000000-0000-4000-8000-000000000002";
          const legacyTurn = "30000000-0000-4000-8000-000000000003";
          const runningTurn = "30000000-0000-4000-8000-000000000004";
          const primitiveTurn = "30000000-0000-4000-8000-000000000005";
          const noticeByCard = "40000000-0000-4000-8000-000000000001";
          const noticeByRef = "40000000-0000-4000-8000-000000000002";
          const invalidNotice = "40000000-0000-4000-8000-000000000003";
          const noticeChild = "40000000-0000-4000-8000-000000000004";
          const forkCutoff = "40000000-0000-4000-8000-000000000005";
          const crossThreadParent = "40000000-0000-4000-8000-000000000006";
          const fork = "10000000-0000-4000-8000-000000000004";
          const forkTurn = "30000000-0000-4000-8000-000000000006";
          const subagent = "10000000-0000-4000-8000-000000000005";
          const subagentTurn = "30000000-0000-4000-8000-000000000007";
          const forkOfFork = "10000000-0000-4000-8000-000000000006";
          const forkOfForkTurn = "30000000-0000-4000-8000-000000000008";
          const handoff = "10000000-0000-4000-8000-000000000007";
          const handoffTurn = "30000000-0000-4000-8000-000000000009";
          const healthyCutoff = "40000000-0000-4000-8000-000000000007";
          const healthyFork = "10000000-0000-4000-8000-000000000008";
          const healthyForkTurn = "30000000-0000-4000-8000-00000000000a";
          const nestedBroken = "10000000-0000-4000-8000-000000000009";
          const nestedBrokenTurn = "30000000-0000-4000-8000-00000000000b";
          const nestedChild = "10000000-0000-4000-8000-00000000000a";
          const nestedChildTurn = "30000000-0000-4000-8000-00000000000c";
          const nestedMissingCutoff = "40000000-0000-4000-8000-000000000008";
          const timestamp = "2026-01-02T03:04:05.000Z";

          await tx`INSERT INTO threads (id, root_thread_id, ref) VALUES (${root}, ${root}, 'root')`;
          await tx`INSERT INTO threads (id, parent_thread_id, root_thread_id, origin_turn_id, origin_type, ref, kind, spawn_status, spawn_depth) VALUES
						(${childOne}, ${root}, ${root}, ${launchTurn}, 'spawn', 'p1', 'subagent', 'succeeded', 1),
						(${childTwo}, ${root}, ${root}, ${launchTurn}, 'spawn', 'p2', 'subagent', 'failed', 1)`;
          await tx`INSERT INTO agent_definition_revisions (id, slug, definition) VALUES
						(${revisionOne}, 'critic', ${tx.json({ metadata: { name: "Continuity Editor" } })}),
						(${revisionTwo}, 'xianxia-editor', ${tx.json({ metadata: {} })})`;
          await tx`INSERT INTO thread_agent_bindings (thread_id, definition_revision_id) VALUES
						(${childOne}, ${revisionOne}), (${childTwo}, ${revisionTwo})`;

          await tx`INSERT INTO turns (id, thread_id, role) VALUES
						(${launchTurn}, ${root}, 'assistant'),
						(${missingStartedTurn}, ${root}, 'assistant'),
						(${legacyTurn}, ${root}, 'assistant'),
						(${runningTurn}, ${root}, 'assistant'),
						(${primitiveTurn}, ${root}, 'assistant'),
						(${noticeByCard}, ${root}, 'system'),
						(${noticeByRef}, ${root}, 'system'),
						(${invalidNotice}, ${root}, 'system'),
						(${noticeChild}, ${root}, 'user')`;
          await tx`UPDATE turns SET parent_turn_id = ${launchTurn} WHERE id = ${invalidNotice}`;
          await tx`UPDATE turns SET parent_turn_id = ${invalidNotice} WHERE id = ${noticeChild}`;
          await tx`UPDATE threads SET active_leaf_turn_id = ${invalidNotice}, conversational_leaf_turn_id = ${invalidNotice} WHERE id = ${root}`;
          await tx`UPDATE turns SET metadata = ${tx.json({ kind: "subagent_update", handle: "p1", execution: "50000000-0000-4000-8000-000000000001", outcome: "succeeded" })} WHERE id = ${noticeByCard}`;
          await tx`UPDATE turns SET metadata = ${tx.json({ kind: "subagent_update", handle: "p2", execution: null, outcome: "failed" })} WHERE id = ${noticeByRef}`;
          await tx`UPDATE turns SET metadata = ${tx.json({ kind: "subagent_update", handle: "gone", execution: null, outcome: "failed" })} WHERE id = ${invalidNotice}`;
          await tx`INSERT INTO event_journal (turn_id) VALUES (${invalidNotice})`;

          await tx`INSERT INTO turns (id, thread_id, role, metadata) VALUES
            (${forkCutoff}, ${root}, 'system', ${tx.json({ kind: "subagent_update", handle: "gone" })}),
            (${crossThreadParent}, ${root}, 'system', ${tx.json({ kind: "subagent_update", handle: "gone" })}),
            (${healthyCutoff}, ${root}, 'assistant', ${tx.json({ kind: "text" })}),
            (${nestedMissingCutoff}, ${subagent}, 'system', ${tx.json({ kind: "subagent_update", handle: "nested-gone" })})`;
          await tx`INSERT INTO threads (id, parent_thread_id, root_thread_id, origin_turn_id, origin_type, kind, spawn_status, spawn_depth) VALUES
            (${fork}, NULL, ${root}, ${forkCutoff}, 'fork', 'primary', NULL, 0),
            (${subagent}, ${fork}, ${root}, ${forkTurn}, 'spawn', 'subagent', 'running', 1),
            (${forkOfFork}, NULL, ${root}, ${forkTurn}, 'fork', 'primary', NULL, 0),
            (${handoff}, NULL, ${root}, ${crossThreadParent}, 'handoff', 'primary', NULL, 0),
            (${healthyFork}, NULL, ${root}, ${healthyCutoff}, 'fork', 'primary', NULL, 0),
            (${nestedBroken}, ${fork}, ${root}, ${nestedMissingCutoff}, 'fork', 'primary', NULL, 1),
            (${nestedChild}, ${fork}, ${root}, ${nestedBrokenTurn}, 'fork', 'primary', NULL, 1)`;
          await tx`INSERT INTO turns (id, thread_id, parent_turn_id, role) VALUES
            (${forkTurn}, ${fork}, ${crossThreadParent}, 'user'),
            (${subagentTurn}, ${subagent}, NULL, 'assistant'),
            (${forkOfForkTurn}, ${forkOfFork}, NULL, 'user'),
            (${handoffTurn}, ${handoff}, ${crossThreadParent}, 'user'),
            (${healthyForkTurn}, ${healthyFork}, ${healthyCutoff}, 'user'),
            (${nestedBrokenTurn}, ${nestedBroken}, ${nestedMissingCutoff}, 'user'),
            (${nestedChildTurn}, ${nestedChild}, NULL, 'user')`;
          await tx`INSERT INTO event_journal (turn_id) VALUES (${forkCutoff}), (${crossThreadParent}), (${nestedMissingCutoff})`;

          const insertCard = async (id: string, turnId: string, props: JsonValue) =>
            tx`INSERT INTO turn_blocks (id, turn_id, block_type, content, created_at)
							VALUES (${id}, ${turnId}, 'custom', ${tx.json({ kind: "helper-result", props })}, ${timestamp})`;
          await insertCard("60000000-0000-4000-8000-000000000001", launchTurn, {
            agentSlug: "critic",
            agentName: "Stale Name",
            parentTurnId: launchTurn,
            toolCallId: "call-1",
            childThreadId: childOne,
            execution: "50000000-0000-4000-8000-000000000001",
            deliveryMode: "background_notification",
            startedAt: timestamp,
            terminalAt: timestamp,
            outcome: "succeeded",
            status: "completed",
          });
          await insertCard("60000000-0000-4000-8000-000000000002", missingStartedTurn, {
            agentSlug: "critic",
            agentName: "Stale Name",
            parentTurnId: missingStartedTurn,
            toolCallId: "call-2",
            childThreadId: childOne,
            execution: "50000000-0000-4000-8000-000000000002",
            deliveryMode: "direct",
            terminalAt: timestamp,
            outcome: "failed",
            status: "failed",
          });
          await insertCard("60000000-0000-4000-8000-000000000003", legacyTurn, {
            agentSlug: "critic",
            agentName: "Stale Name",
            parentTurnId: legacyTurn,
            status: "completed",
            summary: "Legacy report summary",
            payload: { detail: "legacy" },
            childThreadId: childOne,
          });
          await insertCard("60000000-0000-4000-8000-000000000004", runningTurn, {
            agentSlug: "critic",
            agentName: "Stale Name",
            parentTurnId: runningTurn,
            toolCallId: "call-4",
            childThreadId: childOne,
            execution: null,
            deliveryMode: "direct",
            terminalAt: null,
            status: "running",
          });
          await insertCard("60000000-0000-4000-8000-000000000005", primitiveTurn, "broken props");
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }
          // The migration is safe to replay and keeps every remaining card parseable.
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await tx.unsafe(statement);
          }

          const rows = await tx<{ id: string; content: Record<string, unknown> }[]>`
						SELECT id, content FROM turn_blocks ORDER BY id`;
          expect(rows).toHaveLength(5);
          for (const row of rows) {
            expect(
              parseInvocationCard(row.content),
              `${row.id} ${JSON.stringify(row.content)}`,
            ).not.toBeNull();
            expect((row.content.props as Record<string, unknown>).status).toBeUndefined();
          }
          const byId = new Map(rows.map((row) => [row.id, row.content]));
          expect(
            parseInvocationCard(byId.get("60000000-0000-4000-8000-000000000001"))?.agentName,
          ).toBe("Continuity Editor");
          expect(
            parseInvocationCard(byId.get("60000000-0000-4000-8000-000000000002"))?.startedAt,
          ).toEqual(expect.any(String));
          expect(
            parseInvocationCard(byId.get("60000000-0000-4000-8000-000000000003")),
          ).toMatchObject({
            agentName: "Continuity Editor",
            reason: expect.any(String),
          });
          expect(
            parseInvocationCard(byId.get("60000000-0000-4000-8000-000000000004")),
          ).toMatchObject({ terminalAt: null });
          expect(
            parseInvocationCard(byId.get("60000000-0000-4000-8000-000000000005")),
          ).toMatchObject({ agentName: "Subagent" });

          expect(
            await tx`SELECT id FROM turns WHERE id IN (${forkCutoff}, ${crossThreadParent})`,
          ).toEqual([]);
          expect(await tx`SELECT origin_turn_id FROM threads WHERE id = ${fork}`).toEqual([
            { origin_turn_id: forkCutoff },
          ]);
          expect(await tx`SELECT parent_turn_id FROM turns WHERE id = ${forkTurn}`).toEqual([
            { parent_turn_id: crossThreadParent },
          ]);
          expect(
            await tx`SELECT turn_id FROM event_journal WHERE turn_id IN (${forkCutoff}, ${crossThreadParent})`,
          ).toEqual([]);

          // Carry the production one-root invariant on the lineage fixture. The
          // legacy card fixture intentionally has many independent root turns,
          // so the partial predicate excludes that unrelated synthetic data.
          await tx.unsafe(`
            CREATE UNIQUE INDEX temp_turns_thread_single_root
            ON turns (thread_id)
            WHERE parent_turn_id IS NULL
              AND thread_id IN (
                '${fork}', '${subagent}', '${forkOfFork}', '${handoff}', '${healthyFork}',
                '${nestedBroken}', '${nestedChild}'
              )
          `);

          // 0014 owns the one-time cleanup before adding the provenance FK.
          // Select the marked block by content so statement reordering cannot
          // run later DDL against the temp tables or omit part of the repair.
          const statements = lineageRepair.split("--> statement-breakpoint");
          const repairStart = statements.findIndex((statement) =>
            statement.includes("lineage-repair-start"),
          );
          const repairEnd = statements.findIndex((statement) =>
            statement.includes("lineage-repair-end"),
          );
          expect(repairStart).toBeGreaterThanOrEqual(0);
          expect(repairEnd).toBeGreaterThanOrEqual(repairStart);
          for (const statement of statements.slice(repairStart, repairEnd + 1)) {
            if (statement.trim()) await tx.unsafe(statement);
          }
          expect(
            await tx`SELECT parent_thread_id, root_thread_id, origin_turn_id, origin_type, spawn_depth, spawn_status FROM threads WHERE id = ${fork}`,
          ).toEqual([
            {
              parent_thread_id: null,
              root_thread_id: fork,
              origin_turn_id: null,
              origin_type: null,
              spawn_depth: 0,
              spawn_status: null,
            },
          ]);
          expect(await tx`SELECT parent_turn_id FROM turns WHERE id = ${forkTurn}`).toEqual([
            { parent_turn_id: null },
          ]);
          expect(
            await tx`SELECT id, parent_thread_id, root_thread_id, spawn_depth FROM threads WHERE id IN (${subagent}, ${forkOfFork}) ORDER BY id`,
          ).toEqual([
            {
              id: subagent,
              parent_thread_id: fork,
              root_thread_id: fork,
              spawn_depth: 1,
            },
            {
              id: forkOfFork,
              parent_thread_id: null,
              root_thread_id: fork,
              spawn_depth: 0,
            },
          ]);
          expect(
            await tx`SELECT id FROM threads WHERE root_thread_id = ${fork} ORDER BY id`,
          ).toEqual([{ id: fork }, { id: subagent }, { id: forkOfFork }]);
          expect(
            await tx`SELECT parent_thread_id, root_thread_id, origin_turn_id, origin_type, spawn_depth, spawn_status FROM threads WHERE id = ${handoff}`,
          ).toEqual([
            {
              parent_thread_id: null,
              root_thread_id: handoff,
              origin_turn_id: null,
              origin_type: null,
              spawn_depth: 0,
              spawn_status: null,
            },
          ]);
          expect(await tx`SELECT parent_turn_id FROM turns WHERE id = ${handoffTurn}`).toEqual([
            { parent_turn_id: null },
          ]);
          expect(
            await tx`SELECT id, parent_thread_id, root_thread_id, spawn_depth FROM threads WHERE id IN (${nestedBroken}, ${nestedChild}) ORDER BY id`,
          ).toEqual([
            {
              id: nestedBroken,
              parent_thread_id: null,
              root_thread_id: nestedBroken,
              spawn_depth: 0,
            },
            {
              id: nestedChild,
              parent_thread_id: null,
              root_thread_id: nestedBroken,
              spawn_depth: 0,
            },
          ]);
          expect(
            await tx`SELECT parent_thread_id, root_thread_id, origin_turn_id, origin_type, spawn_depth, spawn_status FROM threads WHERE id = ${healthyFork}`,
          ).toEqual([
            {
              parent_thread_id: null,
              root_thread_id: root,
              origin_turn_id: healthyCutoff,
              origin_type: "fork",
              spawn_depth: 0,
              spawn_status: null,
            },
          ]);
          expect(await tx`SELECT parent_turn_id FROM turns WHERE id = ${healthyForkTurn}`).toEqual([
            { parent_turn_id: healthyCutoff },
          ]);
          expect(
            await tx`SELECT thread_id, count(*)::integer AS roots FROM turns WHERE thread_id IN (${fork}, ${handoff}, ${nestedBroken}) AND parent_turn_id IS NULL GROUP BY thread_id ORDER BY thread_id`,
          ).toEqual([
            { thread_id: fork, roots: 1 },
            { thread_id: handoff, roots: 1 },
            { thread_id: nestedBroken, roots: 1 },
          ]);

          const repaired = await tx<{ id: string; metadata: Record<string, unknown> }[]>`
						SELECT id, metadata FROM turns WHERE metadata->>'kind' = 'subagent_update' ORDER BY id`;
          expect(repaired).toHaveLength(2);
          expect(repaired[0]?.metadata).toMatchObject({
            childThreadId: childOne,
            agentName: "Continuity Editor",
          });
          expect(repaired[1]?.metadata).toMatchObject({
            childThreadId: childTwo,
            agentName: "xianxia-editor",
          });
          expect(await tx`SELECT id FROM turns WHERE id = ${invalidNotice}`).toEqual([]);
          expect(
            await tx`SELECT turn_id FROM event_journal WHERE turn_id = ${invalidNotice}`,
          ).toEqual([]);
          expect(await tx`SELECT parent_turn_id FROM turns WHERE id = ${noticeChild}`).toEqual([
            { parent_turn_id: launchTurn },
          ]);
          expect(
            await tx`SELECT active_leaf_turn_id, conversational_leaf_turn_id FROM threads WHERE id = ${root}`,
          ).toEqual([{ active_leaf_turn_id: launchTurn, conversational_leaf_turn_id: launchTurn }]);
        });
      } finally {
        await target.end();
      }
    });
  });
}
