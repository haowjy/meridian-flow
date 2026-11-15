/**
 * The rule the reader swap keeps, on the real Drizzle store and catalog over a scratch Postgres:
 * anything Mars or Flow reports on an Agent's file makes that Agent unavailable, and an Agent
 * never runs with more access than its file says. Also the built-in package, fixing a broken
 * Agent, and a reader bump.
 *
 *   pnpm exec tsx tools/qa/probes/agents-through-mars/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a file with any Mars diagnostic, of any severity, defines nothing
 * - an Agent naming a missing, unavailable or non-invocable subagent or skill is unavailable
 * - a tool rule with a pattern, or on a capability Mars has no Flow row for, makes the Agent
 *   unavailable
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import postgres from "postgres";
import { createDrizzleAgentRevisionStore } from "../../../../apps/server/server/domains/packages/adapters/drizzle-agent-revision-store.ts";
import { resolveAgentConfiguration } from "../../../../apps/server/server/domains/packages/domain/agent-configuration.ts";
import { createBoundAgentCatalog } from "../../../../apps/server/server/domains/packages/domain/bound-agent-catalog.ts";
import {
  seedGeneralAgent,
  seedLaunchAgentPackage,
} from "../../../../apps/server/server/domains/packages/domain/default-package-seeding.ts";
import {
  publishAgentSource,
  recompileStalePackages,
} from "../../../../apps/server/server/domains/packages/domain/source-publication.ts";
import {
  dropDatabaseForUrl,
  ensureDatabaseForUrl,
  isCiRunnerPostgres,
  LOCAL_DEV_POSTGRES_PORT,
} from "../../../dev/lib/dev-db.ts";
import { resolveCurrentRepoRoot } from "../../../dev/lib/dev-env.ts";
import { runMigrations } from "../../../dev/lib/migration-runner.ts";

const USER = "00000000-0000-4000-8000-000000000a71";
const PROJECT = "00000000-0000-4000-8000-000000000a72";
const THREAD = "00000000-0000-4000-8000-000000000a73";
const MANIFEST = '[package]\nname = "probe"\nversion = "0.1.0"\nschema = 1\n';
const OLD_READER = "mars-0.0.0+flow-0";

const agent = (name: string, frontmatter = "") =>
  `---\nname: ${name}\n${frontmatter}---\n\nYou are ${name}.\n`;
const skill = (slug: string, frontmatter = "") =>
  `---\nname: ${slug}\ndescription: A skill.\n${frontmatter}---\n\n${slug} body.\n`;

async function scratchDatabase() {
  const server = new URL(
    process.env.DATABASE_URL && isCiRunnerPostgres(process.env.DATABASE_URL)
      ? process.env.DATABASE_URL
      : `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DEV_POSTGRES_PORT}/postgres`,
  );
  server.pathname = `/amars_probe_${process.pid}_${Date.now().toString(36)}`;
  const url = server.href;
  await ensureDatabaseForUrl(url);
  try {
    await runMigrations({
      databaseUrl: url,
      migrationsDirectory: resolve(resolveCurrentRepoRoot(), "packages/database/src/migrations"),
    });
  } catch (error) {
    await dropDatabaseForUrl(url, []);
    throw error;
  }
  return { url, drop: () => dropDatabaseForUrl(url, []) };
}

const scratch = await scratchDatabase();
const db = createDb(scratch.url, { max: 4 });
const raw = postgres(scratch.url, { max: 1 });
const store = createDrizzleAgentRevisionStore(db);
const catalog = createBoundAgentCatalog({
  store,
  defaultModel: () => "fixture-model",
  unavailableReasons: () => [],
});

const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
};

let cases = 0;
/** Publishes one package with its own coordinate; returns the catalog item of every Agent in it. */
async function publish(files: Record<string, string>, grammarVersion?: string) {
  const coordinate = `probe/case-${++cases}`;
  await publishAgentSource({
    store,
    ownerUserId: USER,
    source: { coordinate, files },
    grammarVersion,
  });
  return coordinate;
}
const listed = async (slug: string) => {
  const page = await catalog.list(USER, { limit: 100 });
  const item = page.agents.find((entry) => entry.slug === slug);
  assert.ok(item, `${slug} is not listed`);
  return item;
};
const resolved = async (slug: string) => {
  const item = await listed(slug);
  const result = await catalog.resolvePrimary(USER, item.selection);
  assert.equal(
    result.ok,
    true,
    `${slug} did not resolve: ${JSON.stringify(item.unavailableReasons)}`,
  );
  if (!result.ok) throw new Error("unreachable");
  return result.configuration;
};

try {
  await db.insert(schema.users).values(conformanceUserValues(USER, "probe-owner"));
  await db.insert(schema.projects).values({ id: PROJECT, userId: USER, name: "P", slug: "p" });
  await db.insert(schema.threads).values({
    rootThreadId: THREAD,
    id: THREAD,
    projectId: PROJECT,
    createdByUserId: USER,
  });

  await check(
    "the built-in package: nine Agents, no diagnostics, read-only stays read-only",
    async () => {
      await seedGeneralAgent(store, "fixture-model");
      await seedLaunchAgentPackage(store);
      const slugs = [
        "general",
        "critic",
        "muse",
        "setup",
        "spark",
        "writer",
        "continuity-checker",
        "reader-sim",
        "writer-helper",
      ];
      for (const slug of slugs) {
        const entry = await store.readCatalogEntry(null, slug);
        assert.ok(entry, `${slug} has no catalog entry`);
        const row = await store.readCatalogRevision(entry.selectedRevisionId);
        assert.ok(row?.definition, `${slug} has no definition`);
        assert.deepEqual(row.diagnostics, [], `${slug} has diagnostics`);
        assert.ok(await store.readRevision(row.id));
      }
      for (const slug of ["general", "critic", "muse", "setup", "spark", "writer"])
        await resolved(slug);
      assert.equal((await resolved("critic")).permission, "read");
      const muse = await store.readCatalogEntry(null, "muse");
      const museConfiguration = await resolved("muse");
      assert.deepEqual(museConfiguration.namedTargets.map((target) => target.name).sort(), [
        "continuity-checker",
        "critic",
        "reader-sim",
        "writer-helper",
      ]);
      assert.ok(muse);
      for (const target of museConfiguration.namedTargets) {
        const revision = await store.readRevision(target.definitionRevisionId);
        assert.ok(revision, `${target.name} is not readable`);
        const configuration = await resolveAgentConfiguration({
          revision,
          store,
          defaultModel: "fixture-model",
        });
        if (["continuity-checker", "reader-sim", "critic"].includes(target.name)) {
          assert.equal(configuration.permission, "read", `${target.name} is not read-only`);
        }
      }
    },
  );

  type Unavailable = { name: string; files: (slug: string) => Record<string, string> };
  const alone =
    (content: (slug: string) => string): Unavailable["files"] =>
    (slug) => ({
      "mars.toml": MANIFEST,
      [`agents/${slug}.md`]: content(slug),
    });
  const fm = (frontmatter: string) => alone(() => `---\nname: A\n${frontmatter}---\n\nBody.\n`);
  const unavailable: Unavailable[] = [
    { name: "unparseable YAML", files: alone(() => "---\nname: [x\n---\n") },
    { name: "duplicate key", files: alone(() => "---\nname: A\nname: A\n---\n") },
    { name: "anchor", files: fm("description: &a A\n") },
    { name: "removed key permission", files: fm("permission: read\n") },
    { name: "removed key disallowed-tools", files: fm("disallowed-tools: [write]\n") },
    { name: "removed value effort adaptive", files: fm("effort: adaptive\n") },
    { name: "wrong type effort 7", files: fm("effort: 7\n") },
    { name: "tools as a list", files: fm("tools: [read]\n") },
    {
      name: "misspelled harness-override (Mars info)",
      files: fm("harness-override: {meridian-flow: {permission: read}}\n"),
    },
    { name: "modelInvocable (Mars info)", files: fm("modelInvocable: false\n") },
    {
      name: "Flow block is a scalar (Mars warning)",
      files: fm("harness-overrides: {meridian-flow: read}\n"),
    },
    {
      name: "Flow block value is null (Mars warning)",
      files: fm("harness-overrides: {meridian-flow: {permission: null}}\n"),
    },
    {
      name: "Flow namespace misspelled (Mars warning)",
      files: fm("harness-overrides: {meridian_flow: {permission: read}}\n"),
    },
    {
      name: "Flow key misspelled (no Mars diagnostic)",
      files: fm("harness-overrides: {meridian-flow: {permision: read}}\n"),
    },
    {
      name: "Flow value invalid (no Mars diagnostic)",
      files: fm("harness-overrides: {meridian-flow: {permission: admin}}\n"),
    },
    { name: "scoped rule on a Flow tool", files: fm('tools: {"write(kb/**)": deny}\n') },
    { name: "no mars.toml", files: (slug) => ({ [`agents/${slug}.md`]: agent("A") }) },
    {
      name: "manifest without schema = 1",
      files: (slug) => ({
        "mars.toml": '[package]\nname = "probe"\nversion = "0.1.0"\n',
        [`agents/${slug}.md`]: agent("A"),
      }),
    },
    {
      name: "manifest with a misspelled table (Mars info)",
      files: (slug) => ({
        "mars.toml": `${MANIFEST}\n[package.tool]\nwrite = "deny"\n`,
        [`agents/${slug}.md`]: agent("A"),
      }),
    },
    {
      name: "[package.tools] present",
      files: (slug) => ({
        "mars.toml": `${MANIFEST}\n[package.tools]\nwrite = "deny"\n`,
        [`agents/${slug}.md`]: agent("A"),
      }),
    },
    { name: "missing skill", files: fm("skills: [nope]\n") },
    {
      name: "skill with a diagnostic",
      files: (slug) => ({
        "mars.toml": MANIFEST,
        [`agents/${slug}.md`]: agent("A", `skills: [${slug}-skill]\n`),
        [`skills/${slug}-skill/SKILL.md`]: skill(`${slug}-skill`, "modelInvocable: false\n"),
      }),
    },
    {
      name: "unavailable subagent",
      files: (slug) => ({
        "mars.toml": MANIFEST,
        [`agents/${slug}.md`]: agent("A", `subagents: [${slug}-child]\n`),
        [`agents/${slug}-child.md`]: agent("Child", "permission: read\n"),
      }),
    },
    {
      name: "subagent that cannot be invoked",
      files: (slug) => ({
        "mars.toml": MANIFEST,
        [`agents/${slug}.md`]: agent("A", `subagents: [${slug}-child]\n`),
        [`agents/${slug}-child.md`]: agent("Child", "model-invocable: false\n"),
      }),
    },
  ];
  for (const [index, entry] of unavailable.entries()) {
    await check(`unavailable: ${entry.name}`, async () => {
      const slug = `u${index}`;
      await publish(entry.files(slug));
      const item = await listed(slug);
      assert.ok(item.unavailableReasons.length > 0, "listed with no reason");
      const result = await catalog.resolvePrimary(USER, item.selection);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "unavailable");
      assert.equal(await store.readRevision(item.selection.definitionRevisionId), undefined);
      const [row] =
        await raw`select definition from agent_definition_revisions where id=${item.selection.definitionRevisionId}`;
      assert.equal(row?.definition, null);
    });
  }

  const never: Array<{ name: string; frontmatter: string; expect: Record<string, unknown> }> = [
    {
      name: "sandbox: read-only",
      frontmatter: "sandbox: read-only\n",
      expect: { permission: "read" },
    },
    {
      name: "model-policies override sandbox read-only",
      frontmatter: "model-policies:\n  - match: {model: m}\n    override: {sandbox: read-only}\n",
      expect: { permission: "read" },
    },
    {
      name: "tools: write deny",
      frontmatter: "tools: {write: deny}\n",
      expect: { "disallowed-tools": ["write"] },
    },
    {
      name: "tools: * deny, read allow",
      frontmatter: 'tools: {"*": deny, read: allow}\n',
      expect: { tools: ["read"] },
    },
    { name: "tools: * deny", frontmatter: 'tools: {"*": deny}\n', expect: { tools: [] } },
    {
      name: "tools: * deny, glob allow (Flow has no glob: met)",
      frontmatter: 'tools: {"*": deny, glob: allow}\n',
      expect: { tools: [] },
    },
    {
      name: "tools: * deny, bash allow (Flow has no bash: met)",
      frontmatter: 'tools: {"*": deny, bash: allow}\n',
      expect: { tools: [] },
    },
    {
      name: "tools: mcp(github) allow (Flow has no MCP: met, no allow-list)",
      frontmatter: 'tools: {"mcp(github)": allow}\n',
      expect: {},
    },
    {
      name: "tools: * deny, read allow, grep ask (ask runs as allow)",
      frontmatter: 'tools: {"*": deny, read: allow, grep: ask}\n',
      expect: { tools: ["read", "grep"] },
    },
    {
      name: "tools: * deny, read allow, write deny",
      frontmatter: 'tools: {"*": deny, read: allow, write: deny}\n',
      expect: { tools: ["read"], "disallowed-tools": ["write"] },
    },
    {
      name: "tools: read allow beside no allow-list",
      frontmatter: "tools: {read: allow}\n",
      expect: {},
    },
    {
      name: "tools: write allow, edit deny",
      frontmatter: "tools: {write: allow, edit: deny}\n",
      expect: { "disallowed-tools": ["write"] },
    },
  ];
  for (const [index, entry] of never.entries()) {
    await check(`never wider: ${entry.name}`, async () => {
      const slug = `n${index}`;
      await publish({
        "mars.toml": MANIFEST,
        [`agents/${slug}.md`]: agent("N", entry.frontmatter),
      });
      const configuration = await resolved(slug);
      assert.partialDeepStrictEqual(configuration, entry.expect);
      if (!("tools" in entry.expect)) assert.equal(configuration.tools, undefined);
      if (!("disallowed-tools" in entry.expect))
        assert.equal(configuration["disallowed-tools"], undefined);
    });
  }

  await check("never wider: one bad Agent and one good one in a package", async () => {
    await publish({
      "mars.toml": MANIFEST,
      "agents/good1.md": agent("Good"),
      "agents/bad1.md": agent("Bad", "permission: read\n"),
    });
    await resolved("good1");
    assert.ok((await listed("bad1")).unavailableReasons.length > 0);
  });

  await check("fixing a broken Agent: save a valid file over an unavailable one", async () => {
    const broken = await catalog.save(USER, {
      slug: "fix1",
      content: agent("Fix", "permission: read\n"),
    });
    assert.ok(broken.unavailableReasons.length > 0);
    assert.equal((await catalog.resolvePrimary(USER, broken.selection)).ok, false);
    const fixed = await catalog.save(USER, {
      slug: "fix1",
      content: agent("Fix", "harness-overrides: {meridian-flow: {permission: read}}\n"),
      expectedRevisionId: broken.selection.definitionRevisionId,
    });
    assert.deepEqual(fixed.unavailableReasons, []);
    assert.equal((await catalog.resolvePrimary(USER, fixed.selection)).ok, true);
  });

  await check(
    "a reader bump: a held selection reaches the current revision, a bound chat keeps resolving, boot recompiles",
    async () => {
      const files = {
        "mars.toml": MANIFEST,
        "agents/b1.md": agent("B", "subagents: [b1-child]\nskills: [b1-skill]\n"),
        "agents/b1-child.md": agent("Child", "mode: subagent\n"),
        "skills/b1-skill/SKILL.md": skill("b1-skill"),
      };
      const coordinate = await publish(files, OLD_READER);
      const oldItem = await listed("b1");
      const oldRevision = await store.readRevision(oldItem.selection.definitionRevisionId);
      assert.equal(oldRevision?.grammarVersion, OLD_READER);
      assert.ok(oldRevision);
      const configuration = await resolveAgentConfiguration({
        revision: oldRevision,
        store,
        defaultModel: "fixture-model",
      });
      assert.equal(await store.bindThread(THREAD, oldRevision.id, configuration, null), true);

      await publishAgentSource({
        store,
        ownerUserId: USER,
        source: { coordinate, files },
        expectedRevisionId: (await store.listInstallations(USER)).find(
          (i) => i.coordinate === coordinate,
        )?.currentRevisionId,
      });
      const entry = await store.readCatalogEntry(USER, "b1");
      assert.ok(entry);
      assert.notEqual(entry.selectedRevisionId, oldRevision.id);
      assert.equal(
        (await store.readCatalogRevision(entry.selectedRevisionId))?.grammarVersion !== OLD_READER,
        true,
      );
      const held = {
        catalogEntryId: entry.id,
        definitionRevisionId: oldRevision.id,
      };
      const reached = await catalog.resolvePrimary(USER, held);
      assert.ok(reached.ok);
      assert.equal(reached.revision.id, entry.selectedRevisionId);

      // A stricter reader: the held old revision was valid, the current one is not.
      const strictCoordinate = await publish(
        { "mars.toml": MANIFEST, "agents/b3.md": agent("B3") },
        OLD_READER,
      );
      const heldStrict = await listed("b3");
      await publishAgentSource({
        store,
        ownerUserId: USER,
        source: {
          coordinate: strictCoordinate,
          files: { "mars.toml": MANIFEST, "agents/b3.md": agent("B3", "permission: read\n") },
        },
        expectedRevisionId: (await store.listInstallations(USER)).find(
          (i) => i.coordinate === strictCoordinate,
        )?.currentRevisionId,
      });
      const refused = await catalog.resolvePrimary(USER, heldStrict.selection);
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.reason, "unavailable");
      const binding = await store.readThreadBinding(THREAD);
      assert.equal(binding?.revision?.id, oldRevision.id);
      for (const target of binding?.configuration.namedTargets ?? []) {
        const child = await store.readRevision(target.definitionRevisionId);
        assert.ok(child);
        await resolveAgentConfiguration({ revision: child, store, defaultModel: "fixture-model" });
      }

      const stale = {
        "mars.toml": MANIFEST,
        "agents/b2.md": agent("B2"),
      };
      await publish(stale, OLD_READER);
      const before = await store.readCatalogEntry(USER, "b2");
      assert.ok(before);
      await recompileStalePackages(store);
      const after = await store.readCatalogEntry(USER, "b2");
      assert.ok(after);
      assert.notEqual(after.selectedRevisionId, before.selectedRevisionId);
      assert.notEqual(
        (await store.readCatalogRevision(after.selectedRevisionId))?.grammarVersion,
        OLD_READER,
      );
      assert.equal(
        (
          await store.listInstallationsWithoutRows(
            (await store.readCatalogRevision(after.selectedRevisionId))?.grammarVersion ?? "",
          )
        ).length,
        0,
      );
    },
  );

  await check(
    "boot recompile: a head that moved to another old-reader revision is recompiled, not skipped",
    async () => {
      const coordinate = await publish(
        { "mars.toml": MANIFEST, "agents/b4.md": agent("B4") },
        OLD_READER,
      );
      const moving: typeof store = {
        ...store,
        async listInstallationsWithoutRows(grammarVersion) {
          const stale = await store.listInstallationsWithoutRows(grammarVersion);
          if (!moved) {
            moved = true;
            await publishAgentSource({
              store,
              ownerUserId: USER,
              source: {
                coordinate,
                files: { "mars.toml": MANIFEST, "agents/b4.md": agent("B4", "model: other\n") },
              },
              grammarVersion: OLD_READER,
              expectedRevisionId: stale.find((i) => i.coordinate === coordinate)?.currentRevisionId,
            });
          }
          return stale;
        },
      };
      let moved = false;
      await recompileStalePackages(moving);
      const head = (await store.listInstallations(USER)).find((i) => i.coordinate === coordinate);
      assert.ok(head);
      const entry = await store.readCatalogEntry(USER, "b4");
      assert.ok(entry);
      assert.notEqual(
        (await store.readCatalogRevision(entry.selectedRevisionId))?.grammarVersion,
        OLD_READER,
      );
    },
  );
} finally {
  await raw.end();
  await db.close();
  await scratch.drop();
}

if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall passed");
