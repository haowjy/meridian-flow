/**
 * Bring rows written for the one-question `ask_user` to the several-question shape, as of this
 * migration: asks (payload, resolution, `opened_at` of an open ask) and each thread's stored
 * `ask_user` definition in `prompt_bakes`. Self-contained on purpose: a migration is frozen, so it
 * embeds the definition the registry published then.
 *
 * Runs outside a transaction and every step is re-runnable, so a crash or a retry is safe. Rows are
 * found in one pass, then written in batches of ids, so no lock outlives a batch; a batch that
 * waits more than `lock_timeout` on a row lock fails fast and is tried again.
 *
 * It runs once. Release it with the old servers stopped: an old server keeps writing the
 * one-question shape after it, and the new server cannot answer such an open ask (its payload has
 * no `questions`), so that thread would wait on a question nobody can answer. The deploy docs'
 * stop-the-writers list is where that is recorded.
 * `prompt_bakes` is insert-only by trigger; the trigger is never
 * disabled. While the session setting below is on, its function lets an UPDATE through, and the
 * function as migration 0015 created it is restored last, so a crash leaves only a bypass nothing
 * turns on, and a re-run restores the same original.
 */
import type postgres from "postgres";

const BATCH = 500;
const LOCK_TIMEOUT = "2s";
const LOCK_ATTEMPTS = 5;
const LOCK_NOT_AVAILABLE = "55P03";
const BAKE_REWRITE_SETTING = "meridian.prompt_bake_rewrite";

/** `enforce_prompt_bake_insert_only()` as migration 0015 created it, with the optional bypass. */
const bakeTriggerFunction = (
  bypass: boolean,
) => `CREATE OR REPLACE FUNCTION enforce_prompt_bake_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN${
  bypass
    ? `
  IF TG_OP = 'UPDATE' AND current_setting('${BAKE_REWRITE_SETTING}', true) = 'on' THEN
    RETURN NEW;
  END IF;`
    : ""
}
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM threads WHERE id = OLD.owner_thread_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Prompt bakes are insert-only'
    USING ERRCODE = '23514', CONSTRAINT = 'prompt_bakes_insert_only';
END;
$$`;

/** The `ask_user` definition as the registry publishes it at this migration. */
const ASK_USER_DEFINITION =
  '{"type":"function","name":"ask_user","description":"Ask the writer up to four questions in one call. Ask only when an answer changes what you would write and you can\'t make a reasonable choice; otherwise choose, say what you chose, and continue. Don\'t ask permission to write: the writer can undo, and your writes aren\'t gated. Batch related questions into one call, because the writer answers them together. Give each question 2\u20134 options; the writer can also answer in their own words or skip a question. Mark one option per question recommended if you have a preference: it\'s used for any question the writer leaves unanswered when they walk away. Asking ends your turn, and the answers arrive as this tool\'s result, one entry per question.","inputSchema":{"type":"object","properties":{"questions":{"minItems":1,"maxItems":4,"type":"array","items":{"type":"object","properties":{"question":{"type":"string","minLength":1},"options":{"minItems":2,"maxItems":4,"type":"array","items":{"type":"object","properties":{"label":{"type":"string","minLength":1},"description":{"type":"string","minLength":1}},"required":["label"],"additionalProperties":false}},"recommended":{"type":"string","minLength":1}},"required":["question","options"],"additionalProperties":false}}},"required":["questions"],"additionalProperties":false}}';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: Json | undefined): value is { [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const batches = (ids: string[]) =>
  Array.from({ length: Math.ceil(ids.length / BATCH) }, (_, n) =>
    ids.slice(n * BATCH, (n + 1) * BATCH),
  );

/** Run an idempotent batch, trying again when it timed out waiting for a row lock. */
async function withLockRetry(batch: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await batch();
    } catch (error) {
      if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt === LOCK_ATTEMPTS)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  await sql.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
  try {
    await rewriteAsks(sql);
    await rewriteBakedTools(sql);
  } finally {
    await sql`RESET lock_timeout`;
  }
}

async function rewriteAsks(sql: postgres.ReservedSql): Promise<void> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM asks
    WHERE (status = 'open' AND opened_at IS NULL)
      OR (kind = 'question' AND (
        payload ? 'question'
        OR resolution->>'kind' IN ('option', 'text', 'skipped')
        OR (resolution->>'kind' = 'timeout' AND resolution ? 'label')))`;
  for (const ids of batches(rows.map(({ id }) => id))) {
    await withLockRetry(async () => {
      // An ask open now counts its 55-minute limit from its creation.
      await sql`UPDATE asks SET opened_at = created_at
      WHERE id = ANY(${ids}::uuid[]) AND status = 'open' AND opened_at IS NULL`;
      await sql`UPDATE asks SET payload = jsonb_build_object('questions', jsonb_build_array(payload))
      WHERE id = ANY(${ids}::uuid[]) AND kind = 'question' AND payload ? 'question'`;
      await sql`UPDATE asks SET resolution = jsonb_build_object('kind', 'answers', 'answers', jsonb_build_array(resolution))
      WHERE id = ANY(${ids}::uuid[]) AND kind = 'question' AND resolution->>'kind' IN ('option', 'text', 'skipped')`;
      await sql`UPDATE asks SET resolution = jsonb_build_object('kind', 'timeout', 'answers',
        jsonb_build_array(jsonb_build_object('kind', 'timeout', 'label', resolution->'label')))
      WHERE id = ANY(${ids}::uuid[]) AND kind = 'question'
        AND resolution->>'kind' = 'timeout' AND resolution ? 'label'`;
    });
  }
}

async function rewriteBakedTools(sql: postgres.ReservedSql): Promise<void> {
  const ids = (
    await sql<{ id: string }[]>`SELECT id FROM prompt_bakes
      WHERE baked_tools @> '[{"name": "ask_user"}]'::jsonb`
  ).map(({ id }) => id);
  if (ids.length === 0) return;
  try {
    await sql.unsafe(bakeTriggerFunction(true));
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'on', false)`;
    for (const batch of batches(ids)) {
      await withLockRetry(async () => {
        const bakes = await sql<{ id: string; tools: Json }[]>`SELECT id, baked_tools AS tools
        FROM prompt_bakes WHERE id = ANY(${batch}::uuid[])`;
        const changes = bakes.flatMap(({ id, tools }) => {
          if (!Array.isArray(tools)) return [];
          let changed = false;
          const next = tools.map((tool) => {
            if (!isObject(tool) || tool.name !== "ask_user") return tool;
            const schema = tool.inputSchema;
            const properties = isObject(schema) ? schema.properties : undefined;
            if (isObject(properties) && "questions" in properties) return tool;
            changed = true;
            return JSON.parse(ASK_USER_DEFINITION) as Json;
          });
          return changed ? [{ id, tools: next }] : [];
        });
        if (changes.length > 0) {
          await sql`UPDATE prompt_bakes AS t SET baked_tools = v.tools
          FROM jsonb_to_recordset(${sql.json(changes)}) AS v(id uuid, tools jsonb) WHERE t.id = v.id`;
        }
      });
    }
  } finally {
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'off', false)`;
    await sql.unsafe(bakeTriggerFunction(false));
  }
}
