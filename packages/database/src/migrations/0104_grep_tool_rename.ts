/**
 * Rename the model's `search` tool to `grep` wherever it is stored, as of this migration.
 * Self-contained on purpose: a migration is frozen, so it embeds what it needs (the `grep`
 * definition and the text decoding `search` applied to a query) instead of importing code
 * that later changes.
 *
 * Runs outside a transaction, in batches by primary key, and every step is re-runnable.
 * `prompt_bakes` is insert-only by trigger; the trigger is never disabled. While the session
 * setting below is on, its function lets an UPDATE through, and the original function is
 * restored last, so a crash leaves only a bypass nothing turns on.
 */
import type postgres from "postgres";

const BATCH = 500;
const BAKE_REWRITE_SETTING = "meridian.prompt_bake_rewrite";

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

/** One tool call or result block of the old tool, in the new tool's terms. */
function rewriteBlock(content: JsonObject): boolean {
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
  // Results were the array of files; they are now the files with their total.
  for (const key of ["output", "result"]) {
    const value = content[key];
    if (Array.isArray(value))
      content[key] = { files: value, totalFiles: value.length, exact: true };
  }
  return true;
}

/** Visit rows `after` a key, `BATCH` at a time, until none are left. */
async function eachBatch<Row extends { id: string }>(
  fetch: (after: string | null) => Promise<Row[]>,
  update: (row: Row) => Promise<void>,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = await fetch(after);
    for (const row of rows) await update(row);
    const last = rows.at(-1);
    if (!last || rows.length < BATCH) return;
    after = last.id;
  }
}

export async function migrate(sql: postgres.ReservedSql): Promise<void> {
  await renameBlocks(sql);
  await renameLists(sql);
  await renameBakedTools(sql);
}

async function renameBlocks(sql: postgres.ReservedSql): Promise<void> {
  type Row = { id: string; content: JsonObject };
  await eachBatch<Row>(
    (after) => sql<Row[]>`SELECT id, content FROM turn_blocks
      WHERE content->>'toolName' = 'search' AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT ${BATCH}`,
    async (row) => {
      if (rewriteBlock(row.content))
        await sql`UPDATE turn_blocks SET content = ${sql.json(row.content)} WHERE id = ${row.id}`;
    },
  );
  // A run live across the deploy names its current tool.
  await sql`UPDATE thread_run_leases
    SET current_tool = jsonb_set(current_tool, '{toolName}', '"grep"')
    WHERE current_tool->>'toolName' = 'search'`;
}

async function renameLists(sql: postgres.ReservedSql): Promise<void> {
  type Row = { id: string; value: JsonObject };
  await eachBatch<Row>(
    (after) => sql<Row[]>`SELECT id, definition AS value FROM agent_definition_revisions
      WHERE definition::text LIKE '%"search"%' AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT ${BATCH}`,
    async ({ id, value }) => {
      const metadata = value.metadata;
      if (isObject(metadata) && renameInObject(metadata, ["tools", "disallowed-tools"]))
        await sql`UPDATE agent_definition_revisions SET definition = ${sql.json(value)} WHERE id = ${id}`;
    },
  );
  type Binding = { id: string; configuration: JsonObject; overlay: JsonObject | null };
  await eachBatch<Binding>(
    (after) => sql<Binding[]>`SELECT thread_id AS id, configuration, invocation_overlay AS overlay
      FROM thread_agent_bindings
      WHERE (configuration::text LIKE '%"search"%' OR invocation_overlay::text LIKE '%"search"%')
        AND (${after}::uuid IS NULL OR thread_id > ${after}::uuid)
      ORDER BY thread_id LIMIT ${BATCH}`,
    async ({ id, configuration, overlay }) => {
      const config = renameInObject(configuration, ["tools", "disallowed-tools"]);
      const overrides = overlay?.overrides;
      const overridden = isObject(overrides) && renameInObject(overrides, ["disallowed-tools"]);
      if (config || overridden)
        await sql`UPDATE thread_agent_bindings
          SET configuration = ${sql.json(configuration)}, invocation_overlay = ${overlay ? sql.json(overlay) : null}
          WHERE thread_id = ${id}`;
    },
  );
}

async function renameBakedTools(sql: postgres.ReservedSql): Promise<void> {
  const [original] = await sql<{ definition: string }[]>`
    SELECT pg_get_functiondef('enforce_prompt_bake_insert_only()'::regprocedure) AS definition`;
  if (!original) throw new Error("enforce_prompt_bake_insert_only() is missing");
  try {
    await sql.unsafe(
      original.definition.replace(
        "BEGIN",
        `BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('${BAKE_REWRITE_SETTING}', true) = 'on' THEN
    RETURN NEW;
  END IF;`,
      ),
    );
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'on', false)`;
    type Row = { id: string; tools: Json };
    await eachBatch<Row>(
      (after) => sql<Row[]>`SELECT id, baked_tools AS tools FROM prompt_bakes
        WHERE baked_tools::text LIKE '%search%' AND (${after}::uuid IS NULL OR id > ${after}::uuid)
        ORDER BY id LIMIT ${BATCH}`,
      async ({ id, tools }) => {
        if (!Array.isArray(tools)) return;
        // The old tool's definition becomes the new one; other descriptions name it in prose.
        const renamed = JSON.parse(
          JSON.stringify(
            tools.map((tool) =>
              isObject(tool) && tool.name === "search" ? JSON.parse(GREP_DEFINITION) : tool,
            ),
          ).replaceAll("`search`", "`grep`"),
        );
        await sql`UPDATE prompt_bakes SET baked_tools = ${sql.json(renamed)} WHERE id = ${id}`;
      },
    );
  } finally {
    await sql`SELECT set_config(${BAKE_REWRITE_SETTING}, 'off', false)`;
    await sql.unsafe(original.definition);
  }
}
