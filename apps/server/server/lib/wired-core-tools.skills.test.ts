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
import { createAllowAllFileAccess } from "../domains/file-policy/index.js";
import {
  type AgentSourceSnapshot,
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
} from "../domains/packages/index.js";
import type { ToolRegistration } from "../domains/runtime/index.js";
import { readThreadSkillFacts } from "../domains/runtime/loop/available-skills.js";
import { createWiredCoreToolRegistrations, type ToolWiringDeps } from "./wired-core-tools.js";

const LAUNCH_AGENTS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../domains/packages/builtin/launch-agents",
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
      { threadId, permission: "edit", threadWorkId: "work-1" },
    ],
    fileAccess: createAllowAllFileAccess({
      skillFacts: (threadId) => readThreadSkillFacts({ threadId, agentRevisions }),
    }),
    agentRevisions,
  } as unknown as ToolWiringDeps;
  const registrations = createWiredCoreToolRegistrations(deps);
  const ctx = { threadId: THREAD_ID, turnId: "turn-1" } as never;
  return async (name: string, input: unknown) => {
    const registration = registrations.find((entry) => entry.definition.name === name);
    const execution = registration?.execution as Extract<
      ToolRegistration["execution"],
      { type: "server" }
    >;
    const result = (await execution.handler(input, ctx)) as {
      isError?: boolean;
      output?: unknown;
    };
    const value = result.isError ? result.output : result;
    return registration?.renderResult?.(value as never) ?? value;
  };
}

describe("skills:// at the model tools", () => {
  it("reads a bound skill's SKILL.md and a resource whole, read-only", async () => {
    const call = await criticTools();
    const skill = await call("read", { path: "skills://story-review/SKILL.md" });
    expect(skill).toMatch(/^skills:\/\/story-review\/SKILL\.md \(read-only\)\n\n---\nname: /);
    const resource = await call("read", { path: "skills://story-review/resources/line-edit.md" });
    expect(resource).toMatch(
      /^skills:\/\/story-review\/resources\/line-edit\.md \(read-only\)\n\n/,
    );
  });

  it("loads a bound skill as read does, pointing at ls, and refuses an unbound one", async () => {
    const call = await criticTools();
    const loaded = await call("skill", { name: "story-review" });
    expect(loaded).toMatch(
      /^skills:\/\/story-review\/SKILL\.md \(read-only\)\nFind this skill's other files with ls\("skills:\/\/story-review"\)\.\n\n---\nname: story-review\n/,
    );
    expect(await call("skill", { name: "creative-writing-modes" })).toEqual({
      message:
        'Skill "creative-writing-modes" isn\'t available. Skills you can load: story-review, writing-principles.',
    });
  });

  it("lists only the skills the binding offers", async () => {
    const call = await criticTools();
    expect(await call("ls", { path: "skills://" })).toEqual([
      { uri: "skills://story-review", kind: "directory", readonly: true },
      { uri: "skills://writing-principles", kind: "directory", readonly: true },
    ]);
    expect(await call("ls", { path: "skills://story-review" })).toEqual([
      { uri: "skills://story-review/resources", kind: "directory", readonly: true },
      { uri: "skills://story-review/SKILL.md", kind: "file", readonly: true },
    ]);
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
    expect(await call("ls", { path: "skills://creative-writing-modes" })).toEqual([]);
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
