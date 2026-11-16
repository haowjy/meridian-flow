/**
 * The rule Save keeps, on the real Drizzle store and the computed catalog over a scratch Postgres:
 * an error, Mars's or Flow's, in one Agent's or skill's file stops that edit from being used (the
 * item keeps its last saved version, or is out with none) and the rest saves; an error in
 * `mars.toml` fails the Save; a warning or info saves with
 * the finding shown; and an Agent that runs never has more access than
 * its file says, except by a warning the Save showed. Writer files are fed through the level
 * reader, as the documents would hold them, and used only once saved. Also the built-in packages,
 * fixing a broken Agent, a chat keeping its revision, and a reader bump.
 *
 *   pnpm exec tsx tools/qa/probes/agents-through-mars/run.mts
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - an error on an Agent or skill file keeps its saved version or leaves it out; on mars.toml it
 *   fails the Save; a warning or info does neither
 * - an Agent naming a missing, unavailable or non-invocable subagent or skill is an error
 * - a tool rule with a pattern, or on a capability Mars has no Flow row for, is an error
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { shownFindings } from "@meridian/contracts/agents";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import postgres from "postgres";
import { createDrizzleAgentRevisionStore } from "../../../../apps/server/server/domains/packages/adapters/drizzle-agent-revision-store.ts";
import { resolveAgentConfiguration } from "../../../../apps/server/server/domains/packages/domain/agent-configuration.ts";
import { createBoundAgentCatalog } from "../../../../apps/server/server/domains/packages/domain/bound-agent-catalog.ts";
import { readBuiltinPackages } from "../../../../apps/server/server/domains/packages/domain/default-package-seeding.ts";
import { GRAMMAR_VERSION } from "../../../../apps/server/server/domains/packages/domain/mars.ts";
import { createInMemoryLevelFiles } from "../../../../apps/server/server/test-support/in-memory-level-files.ts";
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

// A probe Agent is primary unless its frontmatter says otherwise: only `mode: primary` starts a chat.
const primary = (frontmatter: string) =>
  /^mode:/m.test(frontmatter) ? frontmatter : `mode: primary\n${frontmatter}`;
const agent = (name: string, frontmatter = "") =>
  `---\nname: ${name}\n${primary(frontmatter)}---\n\nYou are ${name}.\n`;
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
const levels = createInMemoryLevelFiles();
const builtins = await readBuiltinPackages("fixture-model");
const catalog = createBoundAgentCatalog({
  store,
  levelFiles: levels,
  builtins,
  modelFor: (name) => name ?? "fixture-model",
  unavailableReasons: () => [],
  modelUnavailable: () => [],
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
/** Puts one package's files in the user level as an imported package; each case is its own package. */
function publish(files: Record<string, string>) {
  const name = `case-${++cases}`;
  for (const [path, text] of Object.entries(files))
    levels.write("user", `packages/${name}/${path}`, text);
  return name;
}
const savePackage = async (folder: string) => {
  const [outcome] = await catalog.savePackages(USER, {
    packages: [{ level: "user", folder }],
  });
  assert.ok(outcome, "nothing to save");
  return outcome;
};
/** Publishes the files and Saves them; the Save must go through. */
const publishSaved = async (files: Record<string, string>) => {
  const name = publish(files);
  const outcome = await savePackage(`packages/${name}/`);
  assert.equal(outcome.outcome, "saved", JSON.stringify(outcome.findings));
  return name;
};
const listed = async (slug: string) => {
  const page = await catalog.list(USER, {});
  const item = page.agents.find((entry) => entry.slug === slug);
  assert.ok(item, `${slug} is not listed`);
  return item;
};
const resolved = async (slug: string) => {
  const item = await listed(slug);
  assert.ok(item.selection, `${slug} has no selection`);
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
    "the built-in package: nine Agents at the built-in level, no errors or warnings, read-only stays read-only",
    async () => {
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
      for (const source of builtins) await store.installSource(source);
      for (const slug of slugs) {
        const item = await listed(slug);
        assert.equal(item.level, "builtin");
        assert.ok(item.selection, `${slug} has no selection`);
        const row = await store.readCatalogRevision(item.selection.definitionRevisionId);
        assert.ok(row?.definition, `${slug} has no definition`);
        assert.deepEqual(shownFindings(row.diagnostics), [], `${slug} has diagnostics`);
        assert.ok(await store.readRevision(row.id));
      }
      for (const slug of ["general", "critic", "muse", "setup", "spark", "writer"])
        await resolved(slug);
      assert.equal((await resolved("critic")).permission, "read");
      const museConfiguration = await resolved("muse");
      assert.deepEqual(museConfiguration.namedTargets.map((target) => target.name).sort(), [
        "continuity-checker",
        "critic",
        "reader-sim",
        "writer-helper",
      ]);
      for (const target of museConfiguration.namedTargets) {
        const revision = await store.readRevision(target.definitionRevisionId);
        assert.ok(revision, `${target.name} is not readable`);
        const configuration = await resolveAgentConfiguration({
          revision,
          store,
          modelFor: (name) => name ?? "fixture-model",
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
  const fm = (frontmatter: string) =>
    alone(() => `---\nname: A\n${primary(frontmatter)}---\n\nBody.\n`);
  const unavailable: Unavailable[] = [
    { name: "unparseable YAML", files: alone(() => "---\nname: [x\n---\n") },
    { name: "duplicate key", files: alone(() => "---\nname: A\nname: A\n---\n") },
    { name: "anchor", files: fm("description: &a A\n") },
    { name: "retired key permission (Mars warning)", files: fm("permission: read\n") },
    {
      name: "retired key disallowed-tools (Mars warning)",
      files: fm("disallowed-tools: [write]\n"),
    },
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
      name: "[package.tools] with an action Mars cannot read (package-tools.unreadable)",
      files: (slug) => ({
        "mars.toml": `${MANIFEST}\n[package.tools]\nwrite = "bogus"\n`,
        [`agents/${slug}.md`]: agent("A"),
      }),
    },
    { name: "missing skill", files: fm("skills: [nope]\n") },
    {
      name: "skill with a diagnostic (Mars info)",
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
        [`agents/${slug}-child.md`]: agent("Child", "effort: 7\n"),
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
  /**
   * Cases Mars grades below `error` (a warning or info) and Flow adds no error to save whole;
   * `true` when the Save shows a finding. A manifest error fails the Save. Any other error leaves
   * its Agent out of the saved version and the rest saves.
   */
  const saves = new Map([
    ["misspelled harness-override (Mars info)", false],
    ["modelInvocable (Mars info)", false],
    ["retired key permission (Mars warning)", true],
    ["retired key disallowed-tools (Mars warning)", true],
    ["Flow namespace misspelled (Mars warning)", true],
    ["manifest with a misspelled table (Mars info)", false],
    ["skill with a diagnostic (Mars info)", false],
  ]);
  const fails = new Set([
    "no mars.toml",
    "manifest without schema = 1",
    "[package.tools] with an action Mars cannot read (package-tools.unreadable)",
  ]);
  for (const [index, entry] of unavailable.entries()) {
    const kind = saves.has(entry.name)
      ? "saves with a finding"
      : fails.has(entry.name)
        ? "fails Save"
        : "left out";
    await check(`${kind}: ${entry.name}`, async () => {
      const slug = `u${index}`;
      const name = publish(entry.files(slug));
      const outcome = await savePackage(`packages/${name}/`);
      const files = await catalog.files(USER, {});
      const file = files.files.find((item) => item.slug === slug && item.level === "user");
      const status = files.packages.find(
        (item) => item.level === "user" && item.folder === `packages/${name}/`,
      );
      if (saves.has(entry.name)) {
        assert.equal(outcome.outcome, "saved", JSON.stringify(outcome.findings));
        // Info is silent; a warning is on the result.
        assert.equal(outcome.findings.length > 0, saves.get(entry.name));
        assert.deepEqual(outcome.leftOut, []);
        assert.deepEqual(file?.unavailableReasons, []);
        const item = await listed(slug);
        assert.ok(item.selection, "no selection");
        assert.equal((await catalog.resolvePrimary(USER, item.selection)).ok, true);
        return;
      }
      // A file's Errors are its package's findings: its own, or a package-level one.
      assert.ok(file, "the files don't list it");
      assert.ok(
        status?.findings.some(
          (item) =>
            item.severity === "error" &&
            (item.file === `agents/${slug}.md` || !item.file.startsWith("agents/")),
        ),
        "the files show no Error",
      );
      if (fails.has(entry.name)) {
        assert.equal(outcome.outcome, "failed");
        assert.ok(
          outcome.findings.some((item) => item.severity === "error"),
          "failed with no error",
        );
        assert.equal(
          (await store.readSaved({ userId: USER })).some(
            (row) => row.folder === `packages/${name}/`,
          ),
          false,
        );
        assert.equal(
          (await catalog.list(USER, {})).agents.some((item) => item.slug === slug),
          false,
        );
        return;
      }
      assert.equal(outcome.outcome, "saved", JSON.stringify(outcome.findings));
      assert.ok(outcome.leftOut.includes(`agents/${slug}.md`), `not left out: ${outcome.leftOut}`);
      assert.equal(outcome.findings[0]?.severity, "error", "left-out errors come first");
      // Left out of what runs: listed unavailable with its reason, and no chat binds it.
      const item = await listed(slug);
      assert.ok(item.unavailableReasons.length > 0, "listed with no reason");
      assert.ok(item.selection, "no selection");
      const bound = await catalog.resolvePrimary(USER, item.selection);
      assert.equal(bound.ok, false);
      assert.equal(await store.readRevision(item.selection.definitionRevisionId), undefined);
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
      await publishSaved({
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

  await check(
    "never wider: [package.tools] reaches each Agent, an Agent's own key wins",
    async () => {
      await publishSaved({
        "mars.toml": `${MANIFEST}\n[package.tools]\nwrite = "deny"\nread = "allow"\n`,
        "agents/pt1.md": agent("Plain"),
        "agents/pt2.md": agent("Own", "tools: {write: allow}\n"),
        "agents/pt3.md": agent("Other", "tools: {edit: deny}\n"),
      });
      assert.deepEqual((await resolved("pt1"))["disallowed-tools"], ["write"]);
      assert.equal((await resolved("pt2"))["disallowed-tools"], undefined);
      assert.deepEqual((await resolved("pt3"))["disallowed-tools"], ["write"]);
    },
  );

  await check(
    "one bad Agent is left out of its package's Save; the rest of the package and other packages save",
    async () => {
      const name = publish({
        "mars.toml": MANIFEST,
        "agents/good1.md": agent("Good"),
        "agents/bad1.md": agent("Bad", "effort: 7\n"),
      });
      const outcome = await savePackage(`packages/${name}/`);
      assert.equal(outcome.outcome, "saved");
      assert.deepEqual(outcome.leftOut, ["agents/bad1.md"]);
      await resolved("good1");
      assert.ok((await listed("bad1")).unavailableReasons.length > 0);
    },
  );

  await check("a broken manifest fails the Save and the previous saved version stays", async () => {
    const name = await publishSaved({ "mars.toml": MANIFEST, "agents/mf1.md": agent("Mf") });
    levels.write(
      "user",
      `packages/${name}/mars.toml`,
      '[package]\nname = "probe"\nversion = "0.1.0"\n',
    );
    levels.write("user", `packages/${name}/agents/mf1.md`, agent("Mf", "model: edited-model\n"));
    const outcome = await savePackage(`packages/${name}/`);
    assert.equal(outcome.outcome, "failed");
    assert.equal((await resolved("mf1")).model, "fixture-model");
  });

  await check("fixing a broken Agent: edit the file, Save, and the name is available", async () => {
    levels.write("user", "agents/fix1.md", agent("Fix", "effort: 7\n"));
    const broken = await savePackage("");
    assert.deepEqual(broken.leftOut, ["agents/fix1.md"]);
    assert.ok((await listed("fix1")).unavailableReasons.length > 0);
    levels.write("user", "agents/fix1.md", agent("Fix", "effort: high\n"));
    const fixedOutcome = await savePackage("");
    assert.equal(fixedOutcome.outcome, "saved");
    assert.deepEqual(fixedOutcome.leftOut, []);
    const fixed = await listed("fix1");
    assert.deepEqual(fixed.unavailableReasons, []);
    assert.ok(fixed.selection);
    assert.equal((await catalog.resolvePrimary(USER, fixed.selection)).ok, true);
  });

  await check("a bound chat keeps its revision when the file is edited", async () => {
    levels.write("user", "agents/keep1.md", agent("Keep", "model: first-model\n"));
    assert.equal((await savePackage("")).outcome, "saved");
    const before = await resolved("keep1");
    assert.equal(before.model, "first-model");
    const item = await listed("keep1");
    assert.ok(item.selection);
    const bound = await catalog.resolvePrimary(USER, item.selection);
    assert.ok(bound.ok);
    assert.equal(
      await store.bindThread(THREAD, bound.revision.id, bound.configuration, null),
      true,
    );
    levels.write("user", "agents/keep1.md", agent("Keep", "model: second-model\n"));
    // Edited, not saved: new chats still get the saved version.
    assert.equal((await resolved("keep1")).model, "first-model");
    assert.equal((await savePackage("")).outcome, "saved");
    assert.equal((await resolved("keep1")).model, "second-model");
    assert.equal((await store.readThreadBinding(THREAD))?.revision?.id, bound.revision.id);
    // A new chat binds the newest saved version by name, whatever the picker showed.
    const again = await catalog.resolvePrimary(USER, item.selection);
    assert.ok(again.ok);
    assert.notEqual(again.revision.id, bound.revision.id);
    assert.equal(again.configuration.model, "second-model");
  });

  await check(
    "a reader bump: a revision an older reader compiled is read again by this one",
    async () => {
      const source = {
        coordinate: "probe/old-reader",
        files: {
          "mars.toml": MANIFEST,
          "agents/b1.md": agent("B", "subagents: [b1-child]\n"),
          "agents/b1-child.md": agent("Child", "mode: subagent\n"),
        },
      };
      const old = (await store.installSource(source, OLD_READER)).definitions.find(
        (row) => row.slug === "b1",
      );
      assert.ok(old);
      // The name is saved nowhere, so the picked revision binds: this account's Save holds it.
      await store.savePackage({ userId: USER }, "packages/old-reader/", old.packageRevisionId);
      levels.write("user", "packages/old-reader/agents/unrelated.md", agent("Unrelated"));
      const reached = await catalog.resolvePrimary(USER, {
        slug: "b1",
        definitionRevisionId: old.id,
      });
      assert.ok(reached.ok);
      assert.equal(reached.revision.grammarVersion, GRAMMAR_VERSION);
      assert.notEqual(reached.revision.id, old.id);
      assert.equal(reached.revision.packageRevisionId, old.packageRevisionId);
    },
  );

  await check(
    "a saved Agent of a level hides the built-in of its name, and a later edit with an error leaves its saved version in use",
    async () => {
      levels.write(
        "user",
        "agents/critic.md",
        agent("Critic", "harness-overrides: {meridian-flow: {permission: read}}\n"),
      );
      assert.equal((await savePackage("")).outcome, "saved");
      const item = await listed("critic");
      assert.equal(item.level, "user");
      assert.deepEqual(item.shadows, ["builtin"]);
      levels.write("user", "agents/critic.md", "---\nname: [x\n---\n");
      const kept = await savePackage("");
      assert.deepEqual(kept.kept, ["agents/critic.md"]);
      assert.deepEqual(kept.leftOut, []);
      const out = await listed("critic");
      assert.equal(out.level, "user");
      assert.deepEqual(out.unavailableReasons, []);
      levels.remove("user", "agents/critic.md");
      assert.equal((await savePackage("")).outcome, "saved");
      assert.equal((await listed("critic")).level, "builtin");
    },
  );

  await check("a stray line above the frontmatter leaves the Agent out", async () => {
    levels.write("user", "agents/stray.md", `stray\n${agent("Stray", "effort: 7\n")}`);
    const outcome = await savePackage("");
    assert.deepEqual(outcome.leftOut, ["agents/stray.md"]);
    assert.match(
      outcome.findings.map((item) => item.message).join("\n"),
      /first line that is exactly/,
    );
    levels.remove("user", "agents/stray.md");
  });

  await check("two packages bringing one name rename both and hold the bare name", async () => {
    for (const pkg of ["pa", "pb"]) {
      levels.write("user", `packages/${pkg}/mars.toml`, MANIFEST);
      levels.write("user", `packages/${pkg}/agents/twin.md`, agent("Twin"));
    }
    const first = await savePackage("packages/pa/");
    assert.deepEqual(first.renamed, []);
    const second = await savePackage("packages/pb/");
    assert.deepEqual(second.renamed, ["twin is now twin__pa, twin__pb"]);
    const bare = await listed("twin");
    assert.ok(bare.unavailableReasons.length > 0);
    assert.equal(bare.selection, null);
    await resolved("twin__pa");
    await resolved("twin__pb");
  });
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
