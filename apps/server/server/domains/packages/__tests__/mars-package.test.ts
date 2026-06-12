import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createInMemoryPackageStore } from "../adapters/in-memory-package-store.js";
import {
  type AgentDefinitionRecord,
  definitionContentChecksum,
  exportMarsPackage,
  importLocalMarsPackage,
  parseAgentDefinitionFile,
  parseMarsToml,
  parseSkillDefinitionFile,
  type SkillRecord,
  updateLocalMarsPackage,
} from "../index.js";

const unusedMarsPackageFetcher = {
  async fetch() {
    throw new Error("unused remote package fetcher");
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-mars-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMarsFixture(
  dir: string,
  options: {
    name?: string;
    version?: string;
    dependencies?: string;
    agentBody?: string;
    skillBody?: string;
  } = {},
): Promise<void> {
  await mkdir(path.join(dir, "agents"), { recursive: true });
  await mkdir(path.join(dir, "skills", "skill-one"), { recursive: true });
  await writeFile(
    path.join(dir, "mars.toml"),
    `${
      options.name
        ? `[package]\nname = "${options.name}"\nversion = "${options.version ?? "0.1.0"}"\ndescription = "Test package"\n\n`
        : ""
    }${options.dependencies ?? ""}[agents.agent-one]\nmodel = "gpt-test"\neffort = "high"\n`,
  );
  await writeFile(
    path.join(dir, "agents", "agent-one.md"),
    `---\nname: Agent One\ndescription: Test agent\nskills:\n  - skill-one\nsubagents: []\nmode: primary\n---\n\n${options.agentBody ?? "# Agent One\n"}`,
  );
  await writeFile(
    path.join(dir, "skills", "skill-one", "SKILL.md"),
    `---\nname: Skill One\ndescription: Test skill\ntype: principle\nmodel-invocable: false\nuser-invocable: true\nis-global: false\n---\n\n${options.skillBody ?? "# Skill One\n"}`,
  );
}

describe("parseMarsToml", () => {
  it("parses package metadata, dependencies, local dependencies, and agent overlays", () => {
    const parsed = parseMarsToml(`
[package]
name = "example-analysis"
version = "0.1.0"
description = "Example analysis toolkit"

[dependencies.example-pkg]
url = "https://github.com/meridian-bio/example-pkg"
version = "main"

[local-dependencies.local-tools]
path = "../local-tools"

[agents.measurement-agent]
model = "claude-sonnet-4-20250514"
effort = "high"
`);

    expect(parsed.package).toEqual({
      name: "example-analysis",
      version: "0.1.0",
      description: "Example analysis toolkit",
    });
    expect(parsed.dependencies).toEqual([
      {
        name: "example-pkg",
        url: "https://github.com/meridian-bio/example-pkg",
        version: "main",
        local: false,
      },
      { name: "local-tools", path: "../local-tools", local: true },
    ]);
    expect(parsed.agentOverlays["measurement-agent"]).toEqual({
      model: "claude-sonnet-4-20250514",
      effort: "high",
    });
  });

  it("requires package.name unless a fallback is supplied", () => {
    expect(() => parseMarsToml("[settings]\nmanaged_root = '.codex'\n")).toThrow(/package.name/);
    expect(
      parseMarsToml("[settings]\nmanaged_root = '.codex'\n", { packageNameFallback: "example-pkg" })
        .package.name,
    ).toBe("example-pkg");
  });
});

describe("markdown definition loaders", () => {
  it("loads agent frontmatter, body, and slug", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "measurement-agent.md");
      const raw = `---\nname: Measurement Agent\ndescription: Sample measurements\nskills:\n  - metric-extraction\nsubagents:\n  - analysis-reviewer\nmode: primary\n---\n\nYou extract metrics.\n`;
      await writeFile(file, raw);

      const agent = await parseAgentDefinitionFile(file);

      expect(agent.slug).toBe("measurement-agent");
      expect(agent.meta).toMatchObject({
        name: "Measurement Agent",
        skills: ["metric-extraction"],
        subagents: ["analysis-reviewer"],
        mode: "primary",
      });
      expect(agent.body).toBe("You extract metrics.\n");
    });
  });

  it("loads skill frontmatter with kebab-case keys normalized", async () => {
    await withTempDir(async (dir) => {
      const skillDir = path.join(dir, "metric-extraction");
      await mkdir(skillDir, { recursive: true });
      const file = path.join(skillDir, "SKILL.md");
      await mkdir(path.join(skillDir, "resources"), { recursive: true });
      await writeFile(path.join(skillDir, "resources", "notes.md"), "# Notes\n");
      await writeFile(
        file,
        `---\nname: Metric Extraction\ndescription: Protocol\ntype: reference\nmodel-invocable: true\nuser-invocable: false\nis-global: true\n---\n\n## Protocol\n`,
      );

      const skill = await parseSkillDefinitionFile(file);

      expect(skill.slug).toBe("metric-extraction");
      expect(skill.meta).toMatchObject({
        name: "Metric Extraction",
        type: "reference",
        modelInvocable: true,
        userInvocable: false,
        isGlobal: true,
      });
      expect(skill.body).toBe("## Protocol\n");
      expect(skill.files).toEqual({ "resources/notes.md": "# Notes\n" });
    });
  });

  it("drops legacy inputSchema frontmatter during skill normalization", async () => {
    await withTempDir(async (dir) => {
      const skillDir = path.join(dir, "probe-skill");
      await mkdir(skillDir, { recursive: true });
      const file = path.join(skillDir, "SKILL.md");
      await writeFile(
        file,
        `---\ndescription: Probe\ninput-schema:\n  type: object\n  properties:\n    focus:\n      type: string\n---\n\nProbe body\n`,
      );

      const skill = await parseSkillDefinitionFile(file);

      expect(skill.meta.description).toBe("Probe");
      expect(skill.meta).not.toHaveProperty("inputSchema");
      expect(skill.meta).not.toHaveProperty("input-schema");
    });
  });
});

describe("package import pipeline", () => {
  it("imports package items, overlays, and joins in one repository transaction", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await mkdir(path.join(dir, "skills", "skill-one", "resources"), { recursive: true });
      await writeFile(path.join(dir, "skills", "skill-one", "resources", "notes.md"), "# Notes\n");
      const store = createInMemoryPackageStore();

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });
      const dump = store.dump();

      expect(result.installedPackages.map((pkg) => pkg.packageName)).toEqual(["pkg-one"]);
      expect(result.insertedAgents.map((agent) => agent.slug)).toEqual(["agent-one"]);
      expect(result.insertedSkills.map((skill) => skill.slug)).toEqual(["skill-one"]);
      expect(dump.agentSkills).toHaveLength(1);
      expect(dump.agents[0]?.config).toEqual({ model: "gpt-test", effort: "high" });
    });
  });

  it("imports local path dependencies before the root package", async () => {
    await withTempDir(async (dir) => {
      const depDir = path.join(dir, "dep");
      const rootDir = path.join(dir, "root");
      await mkdir(depDir, { recursive: true });
      await mkdir(rootDir, { recursive: true });
      await writeMarsFixture(depDir, { name: "dep-pkg" });
      await writeMarsFixture(rootDir, {
        name: "root-pkg",
        dependencies: `[dependencies.dep-pkg]\npath = "../dep"\n\n`,
      });
      const store = createInMemoryPackageStore();

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: rootDir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      expect(result.installedPackages.map((pkg) => pkg.packageName)).toEqual([
        "dep-pkg",
        "root-pkg",
      ]);
    });
  });

  it("imports a representative multi-agent package prompt surface", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "multi-agent" });
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---
name: Agent Two
description: Second agent
skills:
  - skill-one
subagents:
  - agent-one
mode: subagent
---

# Agent Two
`,
      );
      const store = createInMemoryPackageStore();

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      expect(result.installedPackages.map((pkg) => pkg.packageName)).toEqual(["multi-agent"]);
      expect(result.insertedAgents.map((agent) => agent.slug).sort()).toEqual([
        "agent-one",
        "agent-two",
      ]);
      expect(result.insertedSkills.map((skill) => skill.slug)).toEqual(["skill-one"]);
    });
  });
});

describe("package update and export", () => {
  it("auto-updates pristine items and skips locally modified items unless forced", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one", agentBody: "# v1\n", skillBody: "# v1\n" });
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await writeMarsFixture(dir, { name: "pkg-one", agentBody: "# v2\n", skillBody: "# v2\n" });
      const pristine = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      expect(pristine.updatedAgents).toEqual(["agent-one"]);
      expect(pristine.updatedSkills).toEqual(["skill-one"]);

      await store.transaction(async (tx) => {
        const agent = await tx.findAgentBySlug("workbench-1", "agent-one");
        if (!agent) throw new Error("missing agent");
        await tx.updateAgentDefinition(agent.id, {
          body: "# local edit\n",
          meta: agent.meta,
          config: agent.config,
          originalContentChecksum: agent.originalContentChecksum,
        });
      });
      await writeMarsFixture(dir, { name: "pkg-one", agentBody: "# v3\n", skillBody: "# v3\n" });

      const skipped = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      expect(skipped.skippedAgents).toEqual(["agent-one"]);
      expect(skipped.updatedSkills).toEqual(["skill-one"]);

      const forced = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        forceReset: true,
      });
      expect(forced.updatedAgents).toEqual(["agent-one"]);
    });
  });

  it("adds new package items and refreshes links during update", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await mkdir(path.join(dir, "skills", "skill-two"), { recursive: true });
      await writeFile(
        path.join(dir, "skills", "skill-two", "SKILL.md"),
        `---\nname: Skill Two\ndescription: New skill\ntype: guardrail\n---\n\n# Skill Two\n`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---\nname: Agent One\ndescription: Test agent\nskills:\n  - skill-two\nsubagents: []\nmode: primary\n---\n\n# Agent One v2\n`,
      );

      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      const resolved = await store.getAgentWithLinkedSkills("workbench-1", "user-1", "agent-one");

      expect(updated.updatedSkills).toContain("skill-two");
      expect(resolved.skills.map((entry) => entry.skill.slug)).toEqual(["skill-two"]);
    });
  });

  it("prunes pristine package-owned items that disappear upstream", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await mkdir(path.join(dir, "skills", "skill-two"), { recursive: true });
      await writeFile(
        path.join(dir, "skills", "skill-two", "SKILL.md"),
        `---
name: Skill Two
description: Removed skill
type: reference
---

# Skill Two
`,
      );
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await rm(path.join(dir, "skills", "skill-two"), { recursive: true, force: true });
      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });

      expect(updated.removedSkills).toEqual(["skill-two"]);
      expect(store.dump().skills.map((skill) => skill.slug)).toEqual(["skill-one"]);
    });
  });

  it("keeps removed package-owned skills when skipped local agents still reference them", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await mkdir(path.join(dir, "skills", "skill-two"), { recursive: true });
      await writeFile(
        path.join(dir, "skills", "skill-two", "SKILL.md"),
        `---
name: Skill Two
description: Locally retained skill
type: reference
---

# Skill Two
`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
  - skill-two
subagents: []
mode: primary
---

# Agent One
`,
      );
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await store.transaction(async (tx) => {
        const agent = await tx.findAgentBySlug("workbench-1", "agent-one");
        if (!agent) throw new Error("missing agent");
        await tx.updateAgentDefinition(agent.id, {
          body: "# local edit\n",
          meta: agent.meta,
          config: agent.config,
          originalContentChecksum: agent.originalContentChecksum,
        });
      });
      await rm(path.join(dir, "skills", "skill-two"), { recursive: true, force: true });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents: []
mode: primary
---

# Agent One upstream
`,
      );

      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      const dump = store.dump();

      expect(updated.skippedAgents).toEqual(["agent-one"]);
      expect(updated.skippedSkills).toEqual(["skill-two"]);
      expect(dump.skills.map((skill) => skill.slug).sort()).toEqual(["skill-one", "skill-two"]);
      expect(dump.agentSkills).toHaveLength(2);
    });
  });

  it("keeps removed subagent dependency graphs referenced by skipped local agents", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await mkdir(path.join(dir, "skills", "skill-two"), { recursive: true });
      await writeFile(
        path.join(dir, "skills", "skill-two", "SKILL.md"),
        `---
name: Skill Two
description: Subagent skill
type: reference
---

# Skill Two
`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Locally edited parent
skills:
  - skill-one
subagents:
  - agent-two
mode: primary
---

# Agent One
`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---
name: Agent Two
description: Removed subagent
skills:
  - skill-two
subagents: []
mode: subagent
---

# Agent Two
`,
      );
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await store.transaction(async (tx) => {
        const agent = await tx.findAgentBySlug("workbench-1", "agent-one");
        if (!agent) throw new Error("missing agent");
        await tx.updateAgentDefinition(agent.id, {
          body: "# local edit\n",
          meta: agent.meta,
          config: agent.config,
          originalContentChecksum: agent.originalContentChecksum,
        });
      });
      await rm(path.join(dir, "agents", "agent-two.md"), { force: true });
      await rm(path.join(dir, "skills", "skill-two"), { recursive: true, force: true });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Locally edited parent
skills:
  - skill-one
subagents: []
mode: primary
---

# Agent One upstream
`,
      );

      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      const dump = store.dump();

      expect(updated.skippedAgents).toEqual(["agent-one", "agent-two"]);
      expect(updated.skippedSkills).toEqual(["skill-two"]);
      expect(dump.agents.map((agent) => agent.slug).sort()).toEqual(["agent-one", "agent-two"]);
      expect(dump.skills.map((skill) => skill.slug).sort()).toEqual(["skill-one", "skill-two"]);
      expect(dump.agentSkills).toHaveLength(2);
    });
  });

  it("prunes removed package-owned agents", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents:
  - agent-two
mode: primary
---

# Agent One
`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---
name: Agent Two
description: Removed subagent
skills: []
subagents: []
mode: subagent
---

# Agent Two
`,
      );
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await rm(path.join(dir, "agents", "agent-two.md"), { force: true });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents: []
mode: primary
---

# Agent One
`,
      );
      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });

      expect(updated.removedAgents).toEqual(["agent-two"]);
    });
  });

  it("soft-retires pruned agents with revision history beyond the seeded pristine row", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---
name: Agent Two
description: Removed subagent
skills: []
subagents: []
mode: subagent
---

# Agent Two
`,
      );
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      await store.transaction(async (tx) => {
        const agent = await tx.findAgentDefinition("workbench-1", "agent-two");
        if (!agent) throw new Error("missing agent-two");
        if (!agent.originalContentChecksum) throw new Error("missing pristine checksum");
        // Restore-style duplicate revision: content still pristine, history diverged.
        await tx.appendAgentDefinitionRevision({
          agentDefinitionId: agent.id,
          contentChecksum: agent.originalContentChecksum,
          body: agent.body,
          meta: agent.meta,
          config: agent.config,
        });
      });

      await rm(path.join(dir, "agents", "agent-two.md"), { force: true });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents: []
mode: primary
---

# Agent One
`,
      );

      const updated = await updateLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
      });
      const dump = store.dump();
      const retired = dump.agents.find((agent) => agent.slug === "agent-two");

      expect(updated.retiredAgents).toEqual(["agent-two"]);
      expect(updated.removedAgents).toEqual([]);
      expect(retired?.enabled).toBe(false);
      expect(retired?.meta.removedFromSource).toBe(true);
      expect(
        dump.agentRevisions.filter((revision) => revision.agentDefinitionId === retired?.id),
      ).toHaveLength(2);
    });
  });

  it("does not retarget package links to colliding workbench records", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      const existingSkill = skillRecord("skill-one", "workbench-1", { type: "reference" });
      const store = createInMemoryPackageStore({ skills: [existingSkill] });

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      expect(result.skippedSkills).toEqual(["skill-one"]);
      expect(store.dump().agentSkills).toEqual([]);
    });
  });

  it("keeps subagent metadata local when workbench agent slugs collide", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await writeFile(
        path.join(dir, "agents", "agent-one.md"),
        `---
name: Agent One
description: Test agent
skills:
  - skill-one
subagents:
  - agent-two
mode: primary
---

# Agent One
`,
      );
      await writeFile(
        path.join(dir, "agents", "agent-two.md"),
        `---
name: Agent Two
description: Colliding source subagent
skills: []
subagents: []
mode: subagent
---

# Agent Two
`,
      );
      const existingAgent = agentRecord("agent-two", "workbench-1");
      const store = createInMemoryPackageStore({ agents: [existingAgent] });

      const result = await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      expect(result.skippedAgents).toEqual(["agent-two"]);
    });
  });

  it("exports an installed package as a mars directory file map", async () => {
    await withTempDir(async (dir) => {
      await writeMarsFixture(dir, { name: "pkg-one" });
      await mkdir(path.join(dir, "skills", "skill-one", "resources"), { recursive: true });
      await writeFile(path.join(dir, "skills", "skill-one", "resources", "notes.md"), "# Notes\n");
      const store = createInMemoryPackageStore();
      await importLocalMarsPackage({
        workbenchId: "workbench-1",
        sourceDir: dir,
        repository: store,
        fetcher: unusedMarsPackageFetcher,
      });

      const exported = await exportMarsPackage({
        workbenchId: "workbench-1",
        packageName: "pkg-one",
        repository: store,
      });

      expect(Object.keys(exported.files).sort()).toEqual([
        "agents/agent-one.md",
        "mars.toml",
        "skills/skill-one/SKILL.md",
        "skills/skill-one/resources/notes.md",
      ]);
      expect(exported.files["agents/agent-one.md"]).toContain("# Agent One");
      expect(exported.files["skills/skill-one/resources/notes.md"]).toBe("# Notes\n");
    });
  });
});

describe("resolution hierarchy", () => {
  it("merges builtin, user, global, and agent-linked skills ordered by type", async () => {
    const builtin = skillRecord("builtin-skill", null, { type: "reference" });
    const userSkill = {
      id: "user-1",
      userId: "user-1",
      slug: "user-skill",
      body: "",
      meta: { type: "guardrail" },
      files: {},
      sourceChecksum: null,
      originalContentChecksum: null,
      enabled: true,
    };
    const globalWorkbench = skillRecord("global-skill", "workbench-1", {
      type: "principle",
      isGlobal: true,
    });
    const linked = skillRecord("linked-skill", "workbench-1", { type: "reference" });
    const agent = agentRecord("agent-one", "workbench-1");
    const store = createInMemoryPackageStore({
      agents: [agent],
      skills: [builtin, globalWorkbench, linked],
      userSkills: [userSkill],
      agentSkills: [{ agentDefinitionId: agent.id, skillId: linked.id }],
    });

    const resolved = await store.getAgentWithLinkedSkills("workbench-1", "user-1", "agent-one");

    expect(resolved.skills.map((entry) => entry.skill.slug)).toEqual([
      "global-skill",
      "user-skill",
      "builtin-skill",
      "linked-skill",
    ]);
    expect(resolved.skills.find((entry) => entry.skill.slug === "linked-skill")?.layer).toBe(
      "workbench",
    );
  });
});

function agentRecord(slug: string, workbenchId: string | null): AgentDefinitionRecord {
  const record = {
    id: `agent-${slug}`,
    workbenchId,
    slug,
    body: "",
    meta: { name: slug },
    config: {},
    packageInstallId: null,
    originalContentChecksum: null,
    sourceType: workbenchId ? "package" : "builtin",
    enabled: true,
  } satisfies AgentDefinitionRecord;
  return record;
}

function skillRecord(
  slug: string,
  workbenchId: string | null,
  meta: Record<string, unknown>,
): SkillRecord {
  const body = "";
  const fullMeta = {
    name: slug,
    modelInvocable: true,
    userInvocable: true,
    isGlobal: false,
    ...meta,
  };
  return {
    id: `skill-${slug}`,
    workbenchId,
    slug,
    body,
    meta: fullMeta,
    files: {},
    packageInstallId: null,
    originalContentChecksum: definitionContentChecksum({ body, meta: fullMeta, files: {} }),
    sourceType: workbenchId ? "package" : "builtin",
    enabled: true,
  };
}
