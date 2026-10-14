/**
 * Populated-upgrade proof for the review-base conversion and the subtractive migrations (0050 to 0055).
 *
 * Builds the train's database (the foundation fixture through 0049) with every row kind the upgrade must carry,
 * then proves, each on its own scratch database cloned from that train: one `db:migrate` invocation converts
 * every base and keeps the rest; a conversion and every no-transaction statement of 0054 survive interruption;
 * the preflight refuses before any migration applies; the B3 guards fire when the step is bypassed; an
 * unconvertible draft stops the run with ids; fresh and upgraded schemas are equal and a second migrate is a no-op.
 *
 * Run: `pnpm --filter @meridian/server exec tsx scripts/prove-review-base-upgrade.ts` (see docs/qa/review-base-upgrade.md).
 * It creates `r4b_proof_<run id>_*` databases on the DATABASE_URL server and drops only those when it finishes.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blocksEqual, readBlocks, rebase, writeBlocks } from "@meridian/agent-edit/diff";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import postgres from "postgres";
import * as Y from "yjs";
import { MIGRATION_DATA_STEPS } from "../../../tools/dev/lib/migration-data-steps.js";
import { formatMigrationFailure, runMigrations } from "../../../tools/dev/lib/migration-runner.js";
import {
  advanceSeededSequences,
  id,
  seedEditLedger,
  seedMainShape,
  seedObservationEvidence,
} from "../server/test-support/foundation-upgrade-fixture.js";
import {
  journalIndex,
  MIGRATIONS,
  readJournal,
  stageThrough,
} from "../server/test-support/staged-migrations.js";

const baseUrl = new URL(process.env.DATABASE_URL ?? "");
const urlOf = (database: string) => {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
const admin = postgres(urlOf("postgres"), { max: 1, onnotice: () => {} });
const created: string[] = [];
const results: string[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  const line = `${ok ? "ok" : "FAIL"} - ${label}`;
  console.log(line + (ok || detail === undefined ? "" : `\n    ${JSON.stringify(detail)}`));
  results.push(line);
  if (!ok) throw new Error(`Assertion failed: ${label}`);
}

/** Every database this invocation makes carries its own random prefix, so concurrent runs share nothing. */
const RUN = `r4b_proof_${randomBytes(4).toString("hex")}`;
const proofDatabase = (role: string) => `${RUN}_${role}`;

/** Creates a database that must not exist; only a successful create is tracked for cleanup. */
async function createDatabase(name: string, template?: string): Promise<string> {
  await admin.unsafe(`CREATE DATABASE ${name}${template ? ` TEMPLATE ${template}` : ""}`);
  created.push(name);
  return urlOf(name);
}

const open = (url: string) => postgres(url, { max: 1, onnotice: () => {} });

// ---------------------------------------------------------------------------------------------
// Yjs fixtures: prose in the shape the train stored.
// ---------------------------------------------------------------------------------------------

const schema = buildDocumentSchema();
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const LIVE_TEXT = ["Alpha opens.", "Beta middle.", "Gamma closes."];
const DRAFT_TEXT = ["Alpha opens, edited.", "Gamma closes."]; // Beta deleted by the writer, Alpha edited

function liveDoc(texts: readonly string[], client = 100): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  doc.clientID = client;
  writeBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, texts.map(paragraph));
  return doc;
}

/** A draft that forked from `cut` and was edited to `texts` by another client. */
function draftFrom(cut: Uint8Array, texts: readonly string[], client = 200): Uint8Array {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, cut);
  doc.clientID = client;
  writeBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema, texts.map(paragraph));
  return Y.encodeStateAsUpdate(doc);
}

const textsOf = (state: Uint8Array): string[] => {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, state);
  const blocks = readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
  doc.destroy();
  return blocks.map((block) => block.textContent);
};

const DOCS = { cutDraft: id(80), sameAsCut: id(81), ensured: id(82), unresolved: id(83) } as const;
const BRANCHES = {
  fixtureLive: "draft-live",
  fixtureDeleted: "draft-deleted-work",
  fixtureClosed: "draft-closed",
  cutDraft: "branch-cut-draft",
  sameAsCut: "branch-same-as-cut",
  ensured: "branch-ensured",
};
const DRAFT_ID_OF_WORK3 = "(SELECT draft_id FROM document_branches WHERE id = 'draft-live')";

// ---------------------------------------------------------------------------------------------
// The train database.
// ---------------------------------------------------------------------------------------------

async function stage(url: string, directory: string, n: number): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await stageThrough(MIGRATIONS, directory, await readJournal(), n);
  await runMigrations({ databaseUrl: url, migrationsDirectory: directory });
}

async function seedTrainRows(sql: postgres.Sql): Promise<void> {
  // The change-trail trigger's owner lookup JITs on every row (about 300 ms); seeding is not what is measured.
  await sql`SET jit = off`;
  const cut = Y.encodeStateAsUpdate(liveDoc(LIVE_TEXT));
  const draft = draftFrom(cut, DRAFT_TEXT);
  const bytes = Buffer.from([0, 0]);
  await sql`INSERT INTO documents (id, context_source_id, name, file_type) VALUES
    (${DOCS.cutDraft}, ${id(6)}, 'cut-draft', 'markdown'), (${DOCS.sameAsCut}, ${id(6)}, 'same-as-cut', 'markdown'),
    (${DOCS.ensured}, ${id(6)}, 'ensured', 'markdown'), (${DOCS.unresolved}, ${id(6)}, 'unresolved', 'markdown')`;

  // The fixture's soft-deleted Work keeps an active draft branch (0044 reopened it): give it real prose.
  await sql`UPDATE document_branches SET state = ${Buffer.from(draft)}, state_vector = ${Buffer.from(Y.encodeStateVectorFromUpdate(draft))},
    live_cut = ${Buffer.from(cut)} WHERE id = ${BRANCHES.fixtureDeleted}`;
  await sql`UPDATE works SET deleted_at = '2026-09-01T00:00:00Z' WHERE id = ${id(4)}`;

  // Yjs-seeded drafts with a live_cut: one the writer changed, one identical to its cut (has_effect was stale).
  const sameState = draftFrom(cut, LIVE_TEXT, 201);
  await sql.unsafe(
    `INSERT INTO document_branches (id, document_id, kind, status, state, state_vector, live_cut, has_effect, draft_id)
    SELECT 'branch-cut-draft', '${DOCS.cutDraft}', 'work_draft', 'active', $1, $2, $3, true, ${DRAFT_ID_OF_WORK3}`,
    [draft, Y.encodeStateVectorFromUpdate(draft), cut] as never,
  );
  await sql.unsafe(
    `INSERT INTO document_branches (id, document_id, kind, status, state, state_vector, live_cut, has_effect, draft_id)
    SELECT 'branch-same-as-cut', '${DOCS.sameAsCut}', 'work_draft', 'active', $1, $2, $3, true, ${DRAFT_ID_OF_WORK3}`,
    [sameState, Y.encodeStateVectorFromUpdate(sameState), cut] as never,
  );
  // An ensured, never-written branch: an untouched copy of live, no live_cut, no journal rows.
  const ensured = Y.encodeStateAsUpdate(liveDoc(LIVE_TEXT, 300));
  await sql.unsafe(
    `INSERT INTO document_branches (id, document_id, kind, status, state, state_vector, has_effect, draft_id)
    SELECT 'branch-ensured', '${DOCS.ensured}', 'work_draft', 'active', $1, $2, true, ${DRAFT_ID_OF_WORK3}`,
    [ensured, Y.encodeStateVectorFromUpdate(ensured)] as never,
  );
  // The fixture's own branch 'draft-live' (state = an empty update, no cut, no journal) is a second ensured branch.

  // Journal rows (generation 1) on the written drafts.
  for (const branch of [BRANCHES.cutDraft, BRANCHES.sameAsCut]) {
    await sql`INSERT INTO branch_write_journal (branch_id, generation, update_data, draft_base_update_seq, source, status)
      VALUES (${branch}, 1, ${bytes}, 0, 'agent', 'active'), (${branch}, 1, ${bytes}, 0, 'writer', 'pushed')`;
  }

  // Edits with action_id and consumes, undo and redo kinds, and parts of every placement the train wrote.
  const [{ id: journalRow }] = await sql<
    { id: string }[]
  >`SELECT id FROM branch_write_journal WHERE branch_id = ${BRANCHES.cutDraft} ORDER BY id LIMIT 1`;
  const kinds = ["write", "undo", "redo", "revert", "rollback"] as const;
  for (const [index, kind] of kinds.entries()) {
    const edit = id(200 + index);
    await sql`INSERT INTO document_edits (id, document_id, thread_id, actor, kind, w_id, action_id, consumes)
      VALUES (${edit}, ${DOCS.cutDraft}, ${id(20)}, 'agent', ${kind}, ${index + 1},
        ${kind === "undo" || kind === "redo" ? id(300 + index) : null},
        ${sql.json(kind === "undo" ? [id(200)] : [])})`;
    const placements = [
      { kind: "pending", branchId: BRANCHES.cutDraft, generation: 1, rowId: Number(journalRow) },
      { kind: "live", seq: 5 },
      { kind: "discarded" },
      { kind: "retired" },
      { kind: "pending", branchId: BRANCHES.sameAsCut, generation: 1, rowId: Number(journalRow) },
    ];
    const placement = placements[index] as Record<string, unknown>;
    const origin = placement.kind === "pending" ? placement : { kind: "live", seq: 5 };
    await sql`INSERT INTO document_edit_parts (edit_id, ordinal, update, effect, frontier, origin, placement)
      VALUES (${edit}, 0, ${bytes}, ${sql.json({ inserted: [], deleted: [] })}, ${sql.json({})}, ${sql.json(origin as never)}, ${sql.json(placement as never)})`;
  }

  // A volume population for the dirty-log measurement: pending parts with generation placements.
  await sql`INSERT INTO document_edits (id, document_id, thread_id, actor, kind, w_id)
    SELECT gen_random_uuid(), ${DOCS.cutDraft}, ${id(20)}, 'agent', 'write', n FROM generate_series(1, 400) n`;
  await sql`INSERT INTO document_edit_parts (edit_id, ordinal, update, effect, frontier, origin, placement)
    SELECT e.id, o, ${bytes}, '{"inserted":[],"deleted":[]}'::jsonb, '{}'::jsonb,
      jsonb_build_object('kind','pending','branchId',${BRANCHES.cutDraft}::text,'generation',1,'rowId',e.w_id),
      jsonb_build_object('kind','pending','branchId',${BRANCHES.cutDraft}::text,'generation',1,'rowId',e.w_id)
    FROM document_edits e, generate_series(0, 4) o WHERE e.w_id > 100`;

  // draft_commands of every kind (kept as written).
  const commandKinds = [
    "apply_items",
    "apply_changes",
    "discard_items",
    "discard_changes",
    "discard_draft",
  ];
  for (const [index, kind] of commandKinds.entries()) {
    await sql.unsafe(
      `INSERT INTO draft_commands (id, work_id, draft_id, account_id, kind, request_digest, state, result, completed_at)
       SELECT $1, '${id(3)}', ${DRAFT_ID_OF_WORK3}, '${id(1)}', $2, $3, 'done', $4::jsonb, now()`,
      [
        id(400 + index),
        kind,
        `digest-${index}`,
        JSON.stringify({ status: "discarded", kind }),
      ] as never,
    );
  }

  // Settlement batches: the fixture's two pending and one blocked, plus a pending zero-member draft_tree batch.
  await sql`INSERT INTO branch_push_settlement_batches (id, state) VALUES (${id(500)}, 'pending')`;
  await sql`INSERT INTO branch_push_settlement_payloads (batch_id, step_kind, payload) VALUES (${id(500)}, 'draft_tree', ${sql.json({ items: [] })})`;
}

async function drainBatches(sql: postgres.Sql): Promise<void> {
  await sql`UPDATE branch_push_settlement_batches SET state = 'completed', completed_at = now(), blocked_at = NULL,
    claim_token = NULL, claim_kind = NULL, claimed_at = NULL, lease_expires_at = NULL WHERE state IN ('pending', 'blocked')`;
}

// ---------------------------------------------------------------------------------------------
// Observations.
// ---------------------------------------------------------------------------------------------

function schemaDump(url: string): string {
  const target = new URL(url);
  target.search = "";
  return execFileSync(
    "pg_dump",
    [
      target.toString(),
      "--schema-only",
      "--schema=public",
      "--schema=drizzle",
      "--no-owner",
      "--no-privileges",
      "--no-comments",
    ],
    { encoding: "utf8" },
  ).replace(/^\\(?:un)?restrict .*$/gm, "");
}

const DROPPED_COLUMNS = [
  ["document_edits", "action_id"],
  ["document_edits", "consumes"],
  ["document_branches", "generation"],
  ["document_branches", "live_cut"],
  ["document_branches", "discarded_state_vector"],
  ["branch_write_journal", "generation"],
  ["push_lineage", "branch_generation"],
] as const;

/** Everything the upgrade must carry, in a comparable shape. */
async function digest(sql: postgres.Sql) {
  return {
    commands: await sql`SELECT * FROM draft_commands ORDER BY id`,
    edits: await sql`SELECT id, kind, w_id FROM document_edits ORDER BY id`,
    modelEditsPage:
      await sql`SELECT id FROM document_edits WHERE actor = 'agent' AND kind IN ('write','revert') ORDER BY id`,
    placements: await sql`SELECT id, placement, origin FROM document_edit_parts ORDER BY id`,
    journalReviewStamps:
      await sql`SELECT id, reviewed_by, reviewed_at, pushed_at FROM branch_write_journal ORDER BY id`,
    lineageJournalIds: await sql`SELECT id, journal_ids FROM push_lineage ORDER BY id`,
  };
}

/** The branch rows after the upgrade (the base columns exist only then). */
async function branchDigest(sql: postgres.Sql) {
  return sql`SELECT id, status, md5(state) AS state, md5(state_vector) AS vector, has_effect, base_revision
    FROM document_branches ORDER BY id`;
}

async function indexDefs(sql: postgres.Sql): Promise<Record<string, string>> {
  const rows = await sql<
    { indexname: string; indexdef: string }[]
  >`SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename IN ('document_branches','branch_write_journal','push_lineage','document_edit_parts','document_edits')`;
  return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]));
}

async function baselineText(
  sql: postgres.Sql,
  branch: string,
): Promise<{ base: string[]; draft: string[] }> {
  const [row] = await sql<
    { state: Buffer }[]
  >`SELECT state FROM document_branches WHERE id = ${branch}`;
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, row.state);
  const read = (fragment: string) =>
    readBlocks(doc.getXmlFragment(fragment), schema).map((block) => block.textContent);
  const out = { base: read("review_base"), draft: read(PROSEMIRROR_FRAGMENT_NAME) };
  doc.destroy();
  return out;
}

async function refusesBadPlacement(sql: postgres.Sql, ordinal: number): Promise<boolean> {
  try {
    await sql`INSERT INTO document_edit_parts (edit_id, ordinal, update, effect, frontier, origin, placement)
      VALUES (${id(200)}, ${ordinal}, ${Buffer.from([0, 0])}, '{}'::jsonb, '{}'::jsonb, '{"kind":"live","seq":1}'::jsonb, '{"kind":"bogus"}'::jsonb)`;
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "23514";
  }
}

async function migrate(
  url: string,
  options: {
    directory?: string;
    dataSteps?: Parameters<typeof runMigrations>[0]["dataSteps"];
  } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await runMigrations({
      databaseUrl: url,
      migrationsDirectory: options.directory ?? MIGRATIONS,
      ...(options.dataSteps ? { dataSteps: options.dataSteps } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: formatMigrationFailure(error, { repoRoot: process.cwd() }) };
  }
}

const realStep = MIGRATION_DATA_STEPS[0];

// ---------------------------------------------------------------------------------------------
// The proof.
// ---------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const journal = await readJournal();
  const work = await mkdtemp(path.join(tmpdir(), "r4b-proof-"));
  const trainUrl = await createDatabase(proofDatabase("train"));
  const train = open(trainUrl);
  const dir = path.join(work, "stage");
  const names = journalIndex(journal, "0037_old_adam_destine");
  await stage(trainUrl, dir, names);
  await seedMainShape(train);
  await stage(trainUrl, dir, names + 1);
  await seedObservationEvidence(train);
  await stage(trainUrl, dir, journalIndex(journal, "0044_work_branch_foundation"));
  await seedEditLedger(train);
  await stage(trainUrl, dir, journalIndex(journal, "0047_d62_chat_write_mode_online") + 1);
  await seedTrainRows(train);
  // The train's own last two migrations (#847's run state) run over the seeded rows before the upgrade.
  const trainHead = journalIndex(journal, "0049_run_state_hand_back_online") + 1;
  await stage(trainUrl, dir, trainHead);
  // The seeds carry explicit ids and revisions: the product's next write must draw above them (R5c U1).
  const advanced = await advanceSeededSequences(train);
  check(
    `train fixture: every sequence stands past its seeded values (advanced ${advanced.join(", ")})`,
    advanced.some((s) => s.startsWith("context_availability_generation_seq")) &&
      advanced.some((s) => s.startsWith("push_lineage_")) &&
      (await advanceSeededSequences(train)).length === 0,
    advanced,
  );
  const appliedAtTrain = (
    await train`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`
  )[0].n;
  check(
    `the train database stands at 0049 (${appliedAtTrain} migrations applied)`,
    appliedAtTrain === trainHead,
  );
  check(
    "train fixture: pending and blocked batches, a zero-member draft_tree batch, and a soft-deleted Work with an active draft",
    (
      await train`SELECT count(*)::int AS n FROM branch_push_settlement_batches WHERE state IN ('pending','blocked')`
    )[0].n === 4 &&
      (
        await train`SELECT count(*)::int AS n FROM works WHERE id = ${id(4)} AND deleted_at IS NOT NULL`
      )[0].n === 1 &&
      (await train`SELECT status FROM document_branches WHERE id = ${BRANCHES.fixtureDeleted}`)[0]
        .status === "active",
  );
  await train.end();

  // -- 1. The preflight refuses with ids before any migration of the run applies ---------------
  const refusedUrl = await createDatabase(proofDatabase("refused"), proofDatabase("train"));
  {
    const sql = open(refusedUrl);
    const before = await schemaDumpAndHistory(sql, refusedUrl);
    const outcome = await migrate(refusedUrl);
    check(
      "preflight refuses while batches are unfinished",
      !outcome.ok && outcome.message.includes("review-base-conversion"),
      outcome,
    );
    const message = outcome.ok ? "" : outcome.message;
    const pending = await sql<
      { id: string }[]
    >`SELECT id FROM branch_push_settlement_batches WHERE state IN ('pending','blocked')`;
    check(
      "the refusal names every unfinished batch by id and state",
      pending.length === 4 &&
        pending.every((batch) => message.includes(batch.id)) &&
        /state blocked/.test(message) &&
        /state pending/.test(message),
      message,
    );
    check(
      "the refusal never says to discard a draft",
      !/discard (the )?draft/i.test(message.replace("do not discard", "")),
      message,
    );
    const after = await schemaDumpAndHistory(sql, refusedUrl);
    check(
      "no migration of the run applied: the old release's schema and history are intact",
      before === after,
    );
    await drainBatches(sql);
    const second = await migrate(refusedUrl);
    check("after the batches drain, the same command succeeds", second.ok, second);
    await sql.end();
  }

  // -- 2. The populated upgrade, one invocation ------------------------------------------------
  const upgradedUrl = await createDatabase(proofDatabase("upgraded"), proofDatabase("train"));
  const upgraded = open(upgradedUrl);
  await drainBatches(upgraded);
  const beforeDigest = await digest(upgraded);
  const dirtyBefore = Number(
    (await upgraded`SELECT count(*) AS n FROM change_trail_dirty_log`)[0].n,
  );
  const partsBefore = Number(
    (
      await upgraded`SELECT count(*) AS n FROM document_edit_parts WHERE placement ? 'generation' OR origin ? 'generation' OR placement->>'kind' = 'retired'`
    )[0].n,
  );
  const draftCuts = new Map<string, { cut: string[]; draft: string[] }>();
  for (const branch of [
    BRANCHES.cutDraft,
    BRANCHES.sameAsCut,
    BRANCHES.ensured,
    BRANCHES.fixtureDeleted,
    BRANCHES.fixtureLive,
  ]) {
    const [row] = await upgraded<
      { state: Buffer; live_cut: Buffer | null }[]
    >`SELECT state, live_cut FROM document_branches WHERE id = ${branch}`;
    draftCuts.set(branch, { cut: textsOf(row.live_cut ?? row.state), draft: textsOf(row.state) });
  }
  const observed: {
    dirtyAtStep?: number;
    indexesAtStep?: Record<string, string>;
    badRefused?: boolean;
    calls: number;
  } = { calls: 0 };
  const started = Date.now();
  const outcome = await migrate(upgradedUrl, {
    dataSteps: [
      {
        ...realStep,
        run: async (session, context) => {
          observed.calls += 1;
          // After 0054 (B2) and before 0055: the dirty-log volume, the index definitions, the checks.
          observed.dirtyAtStep = Number(
            (await session`SELECT count(*) AS n FROM change_trail_dirty_log`)[0].n,
          );
          observed.indexesAtStep = await indexDefs(session as never);
          observed.badRefused = await refusesBadPlacement(session as never, 9001);
          return realStep.run(session, context);
        },
      },
    ],
  });
  check(
    `one db:migrate invocation upgrades the populated train (${Date.now() - started} ms)`,
    outcome.ok,
    outcome,
  );
  check("the data step ran once, between 0054 and 0055", observed.calls === 1);

  for (const branch of [BRANCHES.cutDraft, BRANCHES.sameAsCut, BRANCHES.fixtureDeleted]) {
    const was = draftCuts.get(branch);
    const now = await baselineText(upgraded, branch);
    check(
      `review_base of ${branch} reads as its old live_cut text, draft text unchanged`,
      JSON.stringify(now.base) === JSON.stringify(was?.cut) &&
        JSON.stringify(now.draft) === JSON.stringify(was?.draft),
      { was, now },
    );
  }
  for (const branch of [BRANCHES.ensured, BRANCHES.fixtureLive]) {
    const was = draftCuts.get(branch);
    const now = await baselineText(upgraded, branch);
    check(
      `review_base of ${branch} (no live_cut, never written) reads as its own text`,
      JSON.stringify(now.base) === JSON.stringify(was?.draft) &&
        JSON.stringify(now.draft) === JSON.stringify(was?.draft),
      { was, now },
    );
  }
  const effects = Object.fromEntries(
    (
      await upgraded<
        { id: string; has_effect: boolean; base_revision: unknown }[]
      >`SELECT id, has_effect, base_revision FROM document_branches`
    ).map((row) => [row.id, row]),
  );
  check(
    "has_effect is recomputed: true where the text differs from its base, false otherwise",
    effects[BRANCHES.cutDraft].has_effect === true &&
      effects[BRANCHES.fixtureDeleted].has_effect === true &&
      effects[BRANCHES.sameAsCut].has_effect === false &&
      effects[BRANCHES.ensured].has_effect === false &&
      effects[BRANCHES.fixtureLive].has_effect === false,
    effects,
  );
  check(
    "every converted base carries the initialized-unknown revision; the closed branch was left alone",
    [
      BRANCHES.cutDraft,
      BRANCHES.sameAsCut,
      BRANCHES.ensured,
      BRANCHES.fixtureDeleted,
      BRANCHES.fixtureLive,
    ].every((branch) => effects[branch].base_revision !== null) &&
      effects[BRANCHES.fixtureClosed].base_revision === null,
  );

  const remaining =
    await upgraded`SELECT count(*)::int AS n FROM document_edit_parts WHERE placement ? 'generation' OR origin ? 'generation' OR placement->>'kind' = 'retired'`;
  check(
    `placements are rewritten (${partsBefore} rows carried a generation or retired; ${remaining[0].n} remain)`,
    remaining[0].n === 0,
  );
  const retired =
    await upgraded`SELECT placement FROM document_edit_parts WHERE id IN (SELECT id FROM document_edit_parts WHERE placement->>'kind' = 'discarded')`;
  check(
    "retired parts became discarded and no row was deleted",
    retired.length >= 2 &&
      (await upgraded`SELECT count(*)::int AS n FROM document_edit_parts`)[0].n ===
        beforeDigest.placements.length,
  );

  const defs = await indexDefs(upgraded);
  const defString = Object.values(defs).join("\n");
  check(
    "no index definition mentions a dropped column",
    !/generation|branch_generation|live_cut|discarded_state_vector|action_id/.test(defString),
    defs,
  );
  check(
    "the five replacement indexes have the new definitions",
    /\(\(\(placement ->> 'branchId'::text\)\)\)? WHERE|\(\(placement ->> 'branchId'::text\)\) WHERE/.test(
      defs.document_edit_parts_pending_idx ?? "",
    ) &&
      /\(branch_id, id\)/.test(defs.branch_write_journal_branch ?? "") &&
      /\(branch_id, status\)/.test(defs.branch_write_journal_active ?? "") &&
      /\(draft_id, id\)/.test(defs.document_branches_active_work_draft_by_draft ?? "") &&
      /\(branch_id\)$/.test(defs.push_lineage_branch ?? ""),
    defs,
  );
  check(
    "no `_new` remnant or document_edits_action_idx remains",
    !Object.keys(defs).some(
      (name) => name.endsWith("_new") || name === "document_edits_action_idx",
    ),
  );
  check(
    "the placement check was enforced at the data-step boundary (new check in, old still guarding)",
    observed.badRefused === true,
  );
  check(
    "after the run only the narrowed check remains and it enforces",
    (await refusesBadPlacement(upgraded, 9002)) &&
      (
        await upgraded`SELECT conname FROM pg_constraint WHERE conrelid = 'document_edit_parts'::regclass AND contype = 'c' AND conname LIKE 'document_edit_parts_placement%'`
      )
        .map((row) => row.conname)
        .join() === "document_edit_parts_placement_kind_valid",
  );
  check(
    "the new check is validated",
    (
      await upgraded`SELECT convalidated FROM pg_constraint WHERE conname = 'document_edit_parts_placement_kind_valid'`
    )[0].convalidated === true,
  );
  for (const [table, column] of DROPPED_COLUMNS) {
    const rows =
      await upgraded`SELECT 1 FROM information_schema.columns WHERE table_name = ${table} AND column_name = ${column}`;
    if (rows.length > 0) check(`${table}.${column} is dropped`, false);
  }
  check("the six columns are dropped", true);
  check(
    "reviewed_by, reviewed_at, pushed_at and journal_ids stay",
    (
      await upgraded`SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name = 'branch_write_journal' AND column_name IN ('reviewed_by','reviewed_at','pushed_at')) OR (table_name = 'push_lineage' AND column_name = 'journal_ids')`
    )[0].n === 4,
  );

  const afterDigest = await digest(upgraded);
  const unchanged = (
    key: "commands" | "edits" | "modelEditsPage" | "journalReviewStamps" | "lineageJournalIds",
  ) => JSON.stringify(beforeDigest[key]) === JSON.stringify(afterDigest[key]);
  check(
    "draft_commands of every kind are unchanged",
    beforeDigest.commands.length === 5 && unchanged("commands"),
  );
  check(
    "historical edit kinds (undo, redo, ...) are unchanged and the model edits page lists no new entries",
    unchanged("edits") && unchanged("modelEditsPage"),
  );
  check(
    "journal review stamps and push_lineage.journal_ids are unchanged",
    unchanged("journalReviewStamps") && unchanged("lineageJournalIds"),
  );
  const dirtyAfter = Number(
    (await upgraded`SELECT count(*) AS n FROM change_trail_dirty_log`)[0].n,
  );
  const b2Rows = (observed.dirtyAtStep ?? 0) - dirtyBefore;
  console.log(
    `report - dirty-log volume of the B2 rewrite on the populated fixture: ${b2Rows} rows for ${partsBefore} rewritten parts (${dirtyBefore} before, ${observed.dirtyAtStep} after 0052, ${dirtyAfter} after the run)`,
  );

  // Writer flow: restore the soft-deleted Work, then rebase on the converted base: the deleted paragraph stays deleted.
  await upgraded`UPDATE works SET deleted_at = NULL WHERE id = ${id(4)}`;
  {
    const [row] = await upgraded<
      { state: Buffer }[]
    >`SELECT state FROM document_branches WHERE id = ${BRANCHES.fixtureDeleted}`;
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, row.state);
    const base = readBlocks(doc.getXmlFragment("review_base"), schema);
    const draftBlocks = readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
    const live = [...LIVE_TEXT, "Delta added live."].map(paragraph);
    const merged = rebase(schema, base, live, draftBlocks);
    const text = merged.blocks.map((block) => block.textContent);
    check(
      "restored Work: rebase merges live's new paragraph and the writer's deletion and edit survive",
      text.includes("Delta added live.") &&
        !text.includes("Beta middle.") &&
        text.includes("Alpha opens, edited."),
      text,
    );
    check(
      "restored Work: the base is not the draft (a draft deletion is a change, not nothing)",
      !blocksEqual(base, draftBlocks),
    );
  }

  // A second migrate is a no-op.
  const historyBefore = (await upgraded`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`)
    .map((row) => row.hash)
    .join();
  observed.calls = 0;
  const second = await migrate(upgradedUrl, {
    dataSteps: [
      {
        ...realStep,
        preflight: async () => {
          observed.calls += 1;
        },
        run: async () => {
          observed.calls += 1;
        },
      },
    ],
  });
  check(
    "a second migrate is a no-op (no step ran, history unchanged)",
    second.ok &&
      observed.calls === 0 &&
      (await upgraded`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`)
        .map((row) => row.hash)
        .join() === historyBefore,
  );

  // -- 3. Fresh install ------------------------------------------------------------------------
  const freshUrl = await createDatabase(proofDatabase("fresh"));
  const fresh = await migrate(freshUrl);
  check(
    "a fresh install succeeds (preflight passes when 0044 never ran; the step finds nothing)",
    fresh.ok,
    fresh,
  );
  check(
    "fresh and upgraded schema dumps are equal",
    schemaDump(freshUrl) === schemaDump(upgradedUrl),
  );
  const refusedDump = schemaDump(refusedUrl);
  check(
    "the preflight-drained upgrade ends in the same schema as the one-shot upgrade",
    refusedDump === schemaDump(upgradedUrl),
  );

  // -- 4. Interruption in the conversion ---------------------------------------------------------
  const brokenUrl = await createDatabase(proofDatabase("interrupted"), proofDatabase("train"));
  {
    const sql = open(brokenUrl);
    await drainBatches(sql);
    const interrupted = await migrate(brokenUrl, {
      dataSteps: [
        {
          ...realStep,
          run: async (session, context) => {
            await session.unsafe(`CREATE FUNCTION proof_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
              IF (SELECT count(*) FROM document_branches WHERE base_revision IS NOT NULL) >= 2 THEN RAISE EXCEPTION 'proof interruption'; END IF; RETURN NEW; END $$`);
            await session.unsafe(
              `CREATE TRIGGER proof_interrupt BEFORE UPDATE OF base_revision ON document_branches FOR EACH ROW EXECUTE FUNCTION proof_interrupt()`,
            );
            try {
              return await realStep.run(session, context);
            } finally {
              await session.unsafe("DROP TRIGGER proof_interrupt ON document_branches");
              await session.unsafe("DROP FUNCTION proof_interrupt()");
            }
          },
        },
      ],
    });
    const convertedSoFar = (
      await sql`SELECT count(*)::int AS n FROM document_branches WHERE base_revision IS NOT NULL`
    )[0].n;
    check(
      `a conversion interrupted after ${convertedSoFar} rows stops the run before 0055`,
      !interrupted.ok &&
        convertedSoFar === 2 &&
        (
          await sql`SELECT 1 FROM information_schema.columns WHERE table_name='document_branches' AND column_name='live_cut'`
        ).length === 1,
      interrupted,
    );
    check(
      "the failure names the migration and the step",
      !interrupted.ok &&
        interrupted.message.includes("0055_dbr_drop_branch_generation_columns.sql") &&
        interrupted.message.includes("review-base-conversion@1"),
      interrupted,
    );
    const rerun = await migrate(brokenUrl);
    check("rerunning finishes the conversion", rerun.ok, rerun);
    const sameEnd =
      JSON.stringify([await digest(sql), await branchDigest(sql)]) ===
      JSON.stringify([await digest(upgraded), await branchDigest(upgraded)]);
    check(
      "the interrupted-then-rerun database ends in the same state as the one-shot upgrade",
      sameEnd && schemaDump(brokenUrl) === schemaDump(upgradedUrl),
    );
    await sql.end();
  }

  // -- 5. Interruption between the no-transaction statements of 0054 ------------------------------
  const cutUrl = await createDatabase(proofDatabase("cuts"), proofDatabase("train"));
  {
    const sql = open(cutUrl);
    await drainBatches(sql);
    const directory = path.join(work, "cuts");
    await cp(MIGRATIONS, directory, { recursive: true });
    const file = path.join(directory, "0054_dbr_drop_generation_from_indexes_and_parts.sql");
    const original = await readFile(file, "utf8");
    const statements = original.split("--> statement-breakpoint");
    let enforced = 0;
    for (let cutAt = 1; cutAt < statements.length; cutAt++) {
      await writeFile(
        file,
        [...statements.slice(0, cutAt), "\nSELECT 1 / 0;\n"].join("--> statement-breakpoint"),
      );
      const failed = await migrate(cutUrl, { directory });
      if (
        failed.ok ||
        !failed.message.includes("0054_dbr_drop_generation_from_indexes_and_parts.sql")
      )
        check(`cut ${cutAt} fails in 0054`, false, failed);
      if (await refusesBadPlacement(sql, 9100 + cutAt)) enforced += 1;
    }
    check(
      `placement check enforcement held after every one of ${statements.length - 1} cuts in 0054`,
      enforced === statements.length - 1,
    );
    await writeFile(file, original);
    const finished = await migrate(cutUrl, { directory });
    check("after the last cut, the unmodified run finishes", finished.ok, finished);
    check(
      "the cut-and-rerun database ends in the same state as the one-shot upgrade",
      JSON.stringify([await digest(sql), await branchDigest(sql)]) ===
        JSON.stringify([await digest(upgraded), await branchDigest(upgraded)]) &&
        schemaDump(cutUrl) === schemaDump(upgradedUrl),
    );
    await sql.end();
  }

  // -- 6. B3 guards fire when the step is bypassed ---------------------------------------------------
  const bypassUrl = await createDatabase(proofDatabase("bypass"), proofDatabase("train"));
  {
    const sql = open(bypassUrl);
    await drainBatches(sql);
    const noop = { ...realStep, preflight: async () => {}, run: async () => {} };
    const bypassed = await migrate(bypassUrl, { dataSteps: [noop] });
    check(
      "with the step bypassed the branch guard fires in 0055 and names branch ids",
      !bypassed.ok &&
        bypassed.message.includes(
          "review-base-conversion guard: draft branches have no review base",
        ) &&
        bypassed.message.includes(BRANCHES.cutDraft),
      bypassed,
    );
    check(
      "nothing destructive happened: live_cut and generation columns remain",
      (
        await sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='document_branches' AND column_name IN ('live_cut','generation')`
      )[0].n === 2,
    );
    await sql`UPDATE branch_push_settlement_batches SET state = 'pending', completed_at = NULL WHERE id = ${id(500)}`;
    const converted = await migrate(bypassUrl, {
      dataSteps: [{ ...realStep, preflight: async () => {} }],
    });
    check(
      "with conversion done but a batch unfinished, the settlement guard fires",
      !converted.ok &&
        converted.message.includes("review-base-conversion guard: unfinished settlement batches") &&
        converted.message.includes(id(500)),
      converted,
    );
    await sql.end();
  }

  // -- 7. An unconvertible draft stops the run with ids, then a repaired baseline lets it finish --------
  const stuckUrl = await createDatabase(proofDatabase("unresolved"), proofDatabase("train"));
  {
    const sql = open(stuckUrl);
    await drainBatches(sql);
    const state = Y.encodeStateAsUpdate(liveDoc(DRAFT_TEXT, 400));
    await sql.unsafe(
      `INSERT INTO document_branches (id, document_id, kind, status, state, state_vector, has_effect, draft_id)
      SELECT 'branch-unresolved', '${DOCS.unresolved}', 'work_draft', 'active', $1, $2, true, ${DRAFT_ID_OF_WORK3}`,
      [state, Y.encodeStateVectorFromUpdate(state)] as never,
    );
    await sql`INSERT INTO branch_write_journal (branch_id, generation, update_data, draft_base_update_seq, source, status)
      VALUES ('branch-unresolved', 1, ${Buffer.from([0, 0])}, 0, 'agent', 'active')`;
    const stuck = await migrate(stuckUrl);
    const message = stuck.ok ? "" : stuck.message;
    check(
      "an unconvertible draft stops the run, naming migration, step, branch and document ids",
      !stuck.ok &&
        message.includes("0055_dbr_drop_branch_generation_columns.sql") &&
        message.includes("review-base-conversion@1") &&
        message.includes("branch-unresolved") &&
        message.includes(DOCS.unresolved),
      message,
    );
    check(
      "the failure says to repair or recover the baseline and never to discard the draft",
      /repair or recover/i.test(message) &&
        !/discard the draft/i.test(message.replace("do not discard", "")),
      message,
    );
    check(
      "the stopped run leaves the draft and its history untouched",
      (
        await sql`SELECT count(*)::int AS n FROM document_branches WHERE id = 'branch-unresolved' AND base_revision IS NULL`
      )[0].n === 1,
    );
    await sql`UPDATE document_branches SET live_cut = state WHERE id = 'branch-unresolved'`;
    const repaired = await migrate(stuckUrl);
    check("after the baseline is repaired the same command finishes", repaired.ok, repaired);
    await sql.end();
  }

  await upgraded.end();
  await rm(work, { recursive: true, force: true });
  console.log(`\n${results.length} assertions passed`);
}

async function schemaDumpAndHistory(sql: postgres.Sql, url: string): Promise<string> {
  const history = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id`;
  return JSON.stringify(history) + schemaDump(url);
}

try {
  await main();
} finally {
  for (const name of created)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  await admin.end();
}
