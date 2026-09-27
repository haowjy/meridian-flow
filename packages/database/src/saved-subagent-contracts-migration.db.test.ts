/** Fixtures for repairing the pre-contract saved chat shapes in migration 0009. */
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
      const target = postgres(databaseUrl, { max: 1 });
      try {
        await target.begin(async (tx) => {
          await tx.unsafe(`
						CREATE TEMP TABLE threads (id uuid PRIMARY KEY, root_thread_id uuid, ref text, spawn_status text, active_leaf_turn_id uuid, conversational_leaf_turn_id uuid) ON COMMIT DROP;
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
          const timestamp = "2026-01-02T03:04:05.000Z";

          await tx`INSERT INTO threads (id, root_thread_id, ref) VALUES (${root}, ${root}, 'root')`;
          await tx`INSERT INTO threads (id, root_thread_id, ref, spawn_status) VALUES
						(${childOne}, ${root}, 'p1', 'succeeded'), (${childTwo}, ${root}, 'p2', 'failed')`;
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
