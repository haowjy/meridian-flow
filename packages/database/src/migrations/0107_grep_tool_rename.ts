/**
 * Rename the model's `search` tool to `grep` wherever it is stored, as of this migration.
 * Self-contained on purpose: a migration is frozen, so it embeds what it needs (the `grep`
 * definition and the text decoding `search` applied to a query) instead of importing code
 * that later changes.
 *
 * Runs outside a transaction and every step is re-runnable. Each table is walked in one pass
 * that collects the ids of rows to change, then in batches of ids, each batch written back in
 * one statement. `prompt_bakes` is insert-only by trigger; the trigger is never disabled.
 * While the session setting below is on, its function lets an UPDATE through, and the function
 * as migration 0015 created it is restored last, so a crash leaves only a bypass nothing
 * turns on, and a re-run restores the same original.
 */
import type postgres from "postgres";

const BATCH = 500;
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

/** The `grep` definition as the registry publishes it at this migration. */
const GREP_DEFINITION =
  '{"type": "function", "name": "grep", "description": "Documents are named without an extension (`Chapter 13`); code and data files keep theirs (`outline.json`).\\nSearch document text across all context files with a regular expression.", "inputSchema": {"type": "object", "properties": {"pattern": {"type": "string", "minLength": 1, "maxLength": 512, "description": "RE2 regular expression, ripgrep\'s dialect: no lookaround or backreferences. Matches each line of document text as `read` shows it; `^` and `$` anchor lines. Case-sensitive unless `-i`. Link destinations are not searched."}, "path": {"type": "string", "minLength": 1, "description": "URI prefix to search under, e.g. kb://, kb://protocols or a document."}, "glob": {"type": "string", "minLength": 1, "description": "Only addresses below the scheme root matching this glob, e.g. lore/** or *chapter-0*."}, "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"], "description": "content (default): matching passages with block hashes. files_with_matches: file URIs only. count: file URIs with match counts."}, "-i": {"type": "boolean", "description": "Ignore case."}, "head_limit": {"type": "integer", "minimum": 1, "maximum": 500, "description": "Most files returned; default 50. The result says how many matched in all."}, "verbose": {"type": "boolean", "description": "Show each matching block in full. Leave it off unless you need it."}, "version": {"type": "string", "enum": ["draft", "live"], "description": "Omit for the version your writes change (the document\'s draft in draft mode; scratch and other Works are live). `live` reads the text as the user sees it, without draft changes."}}, "required": ["pattern"], "additionalProperties": false}}';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `search` compared the query's writer-visible text: backslash escapes and character references decoded. */
function decodeQuery(query: string): string {
  const unit = /\\[!-/:-@[-`{-~]|&#[xX]([0-9a-fA-F]{1,6});|&#([0-9]{1,7});/gu;
  return query
    .replace(unit, (match, hex: string | undefined, decimal: string | undefined) => {
      if (match.startsWith("\\")) return match.slice(1);
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : match;
    })
    .normalize("NFC");
}

const quote = (text: string) => text.replace(/[\\.+*?()|[\]{}^$]/gu, "\\$&");

/** `search` in an authored tool list becomes `grep`, in place, without repeating one already there. */
function renameInList(list: Json | undefined): Json[] | null {
  if (!Array.isArray(list) || !list.includes("search")) return null;
  const renamed = list.map((name) => (name === "search" ? "grep" : name));
  return renamed.filter((name, index) => renamed.indexOf(name) === index);
}

function renameInObject(object: JsonObject | undefined, keys: readonly string[]): boolean {
  let changed = false;
  for (const key of keys) {
    const renamed = object ? renameInList(object[key]) : null;
    if (object && renamed) {
      object[key] = renamed;
      changed = true;
    }
  }
  return changed;
}

/** Results were the array of files; they are now the files with their total. */
function rewriteResult(content: JsonObject): boolean {
  let changed = false;
  for (const key of ["output", "result"]) {
    const value = content[key];
    if (Array.isArray(value)) {
      content[key] = { files: value, totalFiles: value.length, exact: true };
      changed = true;
    }
  }
  return changed;
}

/** A call of the old tool, in the new tool's terms. */
function rewriteCall(content: JsonObject): boolean {
  if (content.toolName !== "search") return false;
  content.toolName = "grep";
  if (isObject(content.input)) {
    const { scope, pattern, ...rest } = content.input;
    content.input = {
      ...rest,
      ...(typeof pattern === "string" ? { pattern: quote(decodeQuery(pattern)) } : {}),
      ...(scope === undefined ? {} : { path: scope }),
      "-i": true,
    };
  }
  return true;
}

/**
 * Rewrite the rows `ids` name, `BATCH` at a time: `fetch` reads a batch, `change` returns a row's
 * new values (or null when it needs none), and `write` stores a batch's changes in one statement.
 */
async function rewrite<Row extends { id: string }, Change>(
  ids: string[],
  fetch: (batch: string[]) => Promise<Row[]>,
  change: (row: Row) => Change | null,
  write: (changes: Change[]) => Promise<unknown>,
): Promise<void> {
  for (let at = 0; at < ids.length; at += BATCH) {
    const changes = (await fetch(ids.slice(at, at + BATCH))).flatMap((row) => {
      const changed = change(row);
      return changed ? [changed] : [];
    });
    if (changes.length > 0) await write(changes);
  }
}

const idsOf = (rows: { id: string }[]) => rows.map(({ id }) => id);

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  await renameBlocks(sql);
  await renameLists(sql);
  await renameBakedTools(sql);
}

async function renameBlocks(sql: postgres.ReservedSql): Promise<void> {
  type Row = { id: string; content: JsonObject };
  const write = (rows: Row[]) => sql`UPDATE turn_blocks AS t SET content = v.content
      FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id uuid, content jsonb) WHERE t.id = v.id`;
  const fetch = (batch: string[]) =>
    sql<Row[]>`SELECT id, content FROM turn_blocks WHERE id = ANY(${batch}::uuid[])`;
  // A result block names its call by id only, so its rows are found through the call, which
  // `grep` also covers: a crash after the calls were renamed still finds their results, and a
  // result of `grep` that is already an object is left alone.
  await rewrite(
    idsOf(
      await sql<{ id: string }[]>`SELECT r.id FROM turn_blocks r
        WHERE r.block_type = 'tool_result'
          AND (jsonb_typeof(r.content->'result') = 'array' OR jsonb_typeof(r.content->'output') = 'array')
          AND EXISTS (
            SELECT 1 FROM turn_blocks u
            WHERE u.turn_id = r.turn_id AND u.block_type = 'tool_use'
              AND u.content->>'toolName' IN ('search', 'grep')
              AND u.content->>'toolCallId' = r.content->>'toolCallId')`,
    ),
    fetch,
    ({ id, content }) => (rewriteResult(content) ? { id, content } : null),
    write,
  );
  await rewrite(
    idsOf(
      await sql<{ id: string }[]>`SELECT id FROM turn_blocks WHERE content->>'toolName' = 'search'`,
    ),
    fetch,
    ({ id, content }) => (rewriteCall(content) ? { id, content } : null),
    write,
  );
  // A run live across the deploy names its current tool.
  await sql`UPDATE thread_run_leases
    SET current_tool = jsonb_set(current_tool, '{toolName}', '"grep"')
    WHERE current_tool->>'toolName' = 'search'`;
}

async function renameLists(sql: postgres.ReservedSql): Promise<void> {
  type Row = { id: string; value: JsonObject };
  await rewrite(
    idsOf(
      await sql<{ id: string }[]>`SELECT id FROM agent_definition_revisions
        WHERE definition::text LIKE '%"search"%'`,
    ),
    (batch) => sql<Row[]>`SELECT id, definition AS value FROM agent_definition_revisions
      WHERE id = ANY(${batch}::uuid[])`,
    ({ id, value }) => {
      const metadata = value.metadata;
      return isObject(metadata) && renameInObject(metadata, ["tools", "disallowed-tools"])
        ? { id, value }
        : null;
    },
    (rows) => sql`UPDATE agent_definition_revisions AS t SET definition = v.value
      FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id uuid, value jsonb) WHERE t.id = v.id`,
  );
  type Binding = { id: string; configuration: JsonObject; overlay: JsonObject | null };
  await rewrite(
    idsOf(
      await sql<{ id: string }[]>`SELECT thread_id AS id FROM thread_agent_bindings
        WHERE configuration::text LIKE '%"search"%' OR invocation_overlay::text LIKE '%"search"%'`,
    ),
    (batch) => sql<Binding[]>`SELECT thread_id AS id, configuration, invocation_overlay AS overlay
      FROM thread_agent_bindings WHERE thread_id = ANY(${batch}::uuid[])`,
    ({ id, configuration, overlay }) => {
      const config = renameInObject(configuration, ["tools", "disallowed-tools"]);
      const overrides = overlay?.overrides;
      const overridden = isObject(overrides) && renameInObject(overrides, ["disallowed-tools"]);
      return config || overridden ? { id, configuration, overlay } : null;
    },
    (rows) => sql`UPDATE thread_agent_bindings AS t
      SET configuration = v.configuration, invocation_overlay = v.overlay
      FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id uuid, configuration jsonb, overlay jsonb)
      WHERE t.thread_id = v.id`,
  );
}

async function renameBakedTools(sql: postgres.ReservedSql): Promise<void> {
  try {
    await sql.unsafe(bakeTriggerFunction(true));
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'on', false)`;
    type Row = { id: string; tools: Json };
    await rewrite(
      idsOf(
        await sql<{ id: string }[]>`SELECT id FROM prompt_bakes
          WHERE baked_tools @> '[{"name": "search"}]'::jsonb`,
      ),
      (batch) => sql<Row[]>`SELECT id, baked_tools AS tools FROM prompt_bakes
        WHERE id = ANY(${batch}::uuid[])`,
      ({ id, tools }) => {
        if (!Array.isArray(tools)) return null;
        // The old tool's definition becomes the new one; other descriptions name it in prose.
        const renamed: Json = JSON.parse(
          JSON.stringify(
            tools.map((tool) =>
              isObject(tool) && tool.name === "search" ? JSON.parse(GREP_DEFINITION) : tool,
            ),
          ).replaceAll("`search`", "`grep`"),
        );
        return JSON.stringify(renamed) === JSON.stringify(tools) ? null : { id, tools: renamed };
      },
      (rows) => sql`UPDATE prompt_bakes AS t SET baked_tools = v.tools
        FROM jsonb_to_recordset(${sql.json(rows)}) AS v(id uuid, tools jsonb) WHERE t.id = v.id`,
    );
  } finally {
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'off', false)`;
    await sql.unsafe(bakeTriggerFunction(false));
  }
}
