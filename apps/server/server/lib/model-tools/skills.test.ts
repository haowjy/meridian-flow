/**
 * Skills as files at the wired model tools (D52) and the `skill` tool (D58), on
 * the built-in launch agents: Critic is offered `story-review` and
 * `writing-principles`, so it loads and reads those folders under `skills://`
 * and nothing else.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import {
  type AgentSourceSnapshot,
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../../domains/packages/index.js";
import { createToolExecutor, createToolRegistry } from "../../domains/runtime/index.js";
import { createModelToolRegistrations, type ToolWiringDeps } from "./index.js";

const LAUNCH_AGENTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../domains/packages/builtin/launch-agents",
);
const THREAD_ID = "critic-thread";

async function launchAgentsSource(): Promise<AgentSourceSnapshot> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(LAUNCH_AGENTS, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "mars.toml") continue;
    const absolute = path.join(entry.parentPath, entry.name);
    files[path.relative(LAUNCH_AGENTS, absolute)] = await readFile(absolute, "utf8");
  }
  return { coordinate: "meridian-launch-agents", files };
}

async function criticTools() {
  const agentRevisions = createInMemoryAgentRevisionStore({ threadExists: async () => true });
  const installed = await agentRevisions.installSource(await launchAgentsSource());
  const critic = installed.definitions.find((definition) => definition.slug === "critic");
  if (!critic) throw new Error("Critic definition missing");
  const configuration = await resolveAgentConfiguration({
    revision: critic,
    store: agentRevisions,
    defaultModel: "fixture-model",
  });
  await agentRevisions.bindThread(THREAD_ID, critic.id, configuration, null);
  const deps = {
    threads: { findById: async (id: string) => ({ id, userId: "user-1" }) },
    readAgentChain: async (threadId: string) => [
      {
        threadId,
        permission: "edit",
        threadWorkId: "work-1",
        scratchOwner: { scope: "work", workId: "work-1" },
      },
    ],
    readChainPermission: async () => "edit",
    fileAccess: createAllowAllFileAccess(),
    agentRevisions,
  } as unknown as ToolWiringDeps;
  const executor = createToolExecutor(
    createToolRegistry({ registrations: createModelToolRegistrations(deps) }),
  );
  return async (name: string, input: Record<string, unknown>) =>
    (
      await executor.executeTool({ id: "call-1", name, arguments: input }, {
        threadId: THREAD_ID,
        turnId: "turn-1",
      } as never)
    ).output;
}

describe("skills:// at the model tools", () => {
  it("reads a bound skill's SKILL.md and a resource whole, under the skill header", async () => {
    const call = await criticTools();
    const skill = await call("read", { path: "skills://story-review/SKILL.md" });
    expect(skill).toMatch(
      /^skills:\/\/story-review\/SKILL\.md\nPaths in this skill are relative to skills:\/\/story-review\/\.\n\n---\nname: /,
    );
    const resource = await call("read", { path: "skills://story-review/resources/line-edit.md" });
    expect(resource).toMatch(
      /^skills:\/\/story-review\/resources\/line-edit\.md\nPaths in this skill are relative to skills:\/\/story-review\/\.\n\n/,
    );
  });

  it("reads a markdown file's #heading section and outline with document slugs (D60)", async () => {
    const call = await criticTools();
    const file = "skills://story-review/resources/line-edit.md";
    const section = (await call("read", { path: `${file}#method` })) as string;
    expect(section).toMatch(
      /^skills:\/\/story-review\/resources\/line-edit\.md#method\nPaths in this skill are relative to skills:\/\/story-review\/\.\n\n## Method\n/,
    );
    expect(section).not.toContain("## Check");
    // A GitHub-style slug (case, doubled hyphens) finds the same section.
    expect(await call("read", { path: `${file}#--Method` })).toContain("## Method\n");
    expect(await call("read", { path: file, format: "outline" })).toContain(
      [
        `Read a section with read({"path": "${file}#<slug>"}).`,
        "",
        "# Line Edit  #line-edit",
        "## Method  #method",
        "## Check  #check",
      ].join("\n"),
    );
    expect(await call("read", { path: `${file}#nope` })).toContain(
      'Section "#nope" was not found.',
    );
    expect(await call("read", { path: file, in: "abcd" })).toBe(
      "Invalid arguments for read:\n- in: skills:// files have no block hashes, so in doesn't work here. Read the whole file or a #heading.",
    );
  });

  it("loads a bound skill exactly as read does, and refuses an unbound one", async () => {
    const call = await criticTools();
    const loaded = await call("skill", { name: "story-review" });
    expect(loaded).toBe(await call("read", { path: "skills://story-review/SKILL.md" }));
    expect(loaded).toMatch(/^skills:\/\/story-review\/SKILL\.md\nPaths in this skill are relative/);
    expect(await call("skill", { name: "creative-writing-modes" })).toBe(
      'Skill "creative-writing-modes" isn\'t available. Skills you can load: story-review, writing-principles. (not_found)',
    );
  });

  it("lists only the skills the binding offers", async () => {
    const call = await criticTools();
    expect(await call("ls", { path: "skills://" })).toBe(
      "skills://\n  story-review/ (read-only)\n  writing-principles/ (read-only)",
    );
    expect(await call("ls", { path: "skills://story-review" })).toBe(
      "skills://story-review/\n  resources/ (read-only)\n  SKILL.md (read-only)",
    );
  });

  it("answers an unbound skill and a path out of the folder as not found", async () => {
    const call = await criticTools();
    for (const path of [
      "skills://creative-writing-modes/SKILL.md",
      "skills://story-review/../creative-writing-modes/SKILL.md",
    ]) {
      expect(await call("read", { path })).toBe(
        `status: document_not_found; path: ${path}\n\nFile not found. Check the path with \`ls\`.`,
      );
    }
    expect(await call("ls", { path: "skills://creative-writing-modes" })).toBe(
      "skills://creative-writing-modes/\n  (empty)",
    );
  });

  it("refuses writes to skills://", async () => {
    const call = await criticTools();
    expect(
      await call("write", {
        command: "create",
        path: "skills://story-review/notes.md",
        content: "x",
      }),
    ).toContain("Files under skills:// can only be read.");
  });
});
