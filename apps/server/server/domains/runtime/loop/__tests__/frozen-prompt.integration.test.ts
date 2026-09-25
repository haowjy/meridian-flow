/** Provider-request contract: dynamic context and same-Agent derivation preserve prompt bytes. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBoundAgentCatalog,
  createInMemoryAccountSkillInstallStore,
  createInMemoryAgentRevisionStore,
} from "../../../packages/index.js";
import {
  createInMemoryProjectRepository,
  createInMemoryWorkRepository,
} from "../../../projects/index.js";
import { createInMemoryRepositories } from "../../../threads/adapters/in-memory/repositories.js";
import {
  forkThreadAgent,
  handoffThreadAgent,
  rebindThreadWork,
  type ThreadAgentSwapDeps,
} from "../../../threads/index.js";
import type { Message } from "../../gateway/index.js";
import { createReportPublisher } from "../../spawn/report-publisher.js";
import { createWorkContextReader } from "../work-context.js";
import { createRuntimeHarness } from "./runtime-harness.js";
import { scriptedGateway } from "./test-gateway.js";

function systemHash(messages: Message[]) {
  const system = messages.filter((message) => message.role === "system");
  expect(system).toHaveLength(1);
  const text = system[0].content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return createHash("sha256").update(text).digest("hex");
}

async function fixture(onStream?: (call: number) => Promise<void>) {
  const projects = createInMemoryProjectRepository();
  const works = createInMemoryWorkRepository();
  const repos = createInMemoryRepositories({
    projects,
    works,
    boundAgent: (id) => agentRevisions.boundAgent(id),
  });
  const agentRevisions = createInMemoryAgentRevisionStore({
    threadExists: async (id) => Boolean(await repos.threads.findById(id)),
  });
  const agentCatalog = createBoundAgentCatalog({
    store: agentRevisions,
    defaultModel: () => "gpt-4.1-mini",
    unavailableReasons: () => [],
  });
  const original = await agentCatalog.save("user-1", {
    slug: "writer",
    content: "---\nname: Writer\nmode: primary\n---\n\nOriginal writer.",
  });
  const alternate = await agentCatalog.save("user-1", {
    slug: "editor",
    content: "---\nname: Editor\nmode: primary\n---\n\nDifferent editor.",
  });
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const noWork = await works.ensureNoWork(project.id);
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  await repos.threadWorks.addMembership(thread.id, noWork.id, true);
  const binding = await agentCatalog.resolvePrimary(thread.userId, original.selection);
  if (!binding.ok) throw new Error("Fixture binding unavailable");
  await agentRevisions.bindThread(thread.id, binding.revision.id, binding.configuration, null);
  const gateway = scriptedGateway({ onStream });
  const workContext = createWorkContextReader({ ...repos, works });
  const accountSkillInstalls = createInMemoryAccountSkillInstallStore();
  const rig = createRuntimeHarness({
    repos,
    agentRevisions,
    gateway,
    workContext,
    accountSkillInstalls,
  });
  await rig.creditLedger.grant({
    userId: thread.userId,
    source: "manual",
    amountMillicredits: "1000000",
    reason: "fixture",
  });
  const derive: ThreadAgentSwapDeps = {
    ...repos,
    projects,
    works,
    agentRevisions,
    agentCatalog,
    eventWriter: rig.deps.eventWriter,
    workContextNotices: rig.delivery,
  };
  async function run(threadId = thread.id) {
    const run = await rig.orchestrator.prepare({ threadId, userText: "Continue." });
    expect((await run.execute()).status).toBe("complete");
    return run;
  }
  return {
    ...rig,
    accountSkillInstalls,
    repos,
    thread,
    works,
    original,
    alternate,
    derive,
    run,
    requests: gateway.requests,
  };
}

describe("frozen prompt provider requests", () => {
  it("keeps one hash through steer, child notice, request-only notice, skill and Work switch across runs", async () => {
    const rig = await fixture(async (call) => {
      if (call === 1) {
        await rig.send(rig.thread.id, "Tighten the dialogue.", { activatedSkillSlugs: ["craft"] });
        await rig.delivery.enqueue({
          threadId: rig.thread.id,
          intent: "notice",
          provenance: { kind: "system", source: "probe" },
          body: { kind: "text", text: "Request-only reminder." },
          idempotencyKey: "reminder",
        });
      }
    });
    await rig.accountSkillInstalls.insert({
      ownerUserId: rig.thread.userId,
      slug: "craft",
      name: "Craft",
      description: "Dialogue craft",
      body: "Use distinctive dialogue.",
    });
    const first = await rig.run();
    expect(rig.requests).toHaveLength(2);
    const child = await rig.repos.threads.createSubagent({
      userId: rig.thread.userId,
      projectId: rig.thread.projectId,
      parentThreadId: rig.thread.id,
      rootThreadId: rig.thread.id,
      spawnDepth: 1,
    });
    const execution = await rig.repos.turns.create({
      threadId: child.id,
      role: "assistant",
      status: "complete",
    });
    await rig.repos.executionReports.admit({
      childThreadId: child.id,
      assistantTurnId: execution.id,
      handle: child.ref ?? "",
      origin: "spawn",
      deliveryMode: "background_notification",
      callerThreadId: rig.thread.id,
      callerTurnId: first.assistantTurnId,
      toolCallId: "spawn-1",
      cardBlockId: null,
    });
    await rig.repos.executionReports.finalizeOnce({
      childThreadId: child.id,
      assistantTurnId: execution.id,
      outcome: "succeeded",
      reason: null,
      source: "return_result",
      summary: "Private report body",
    });
    await createReportPublisher({
      repos: rig.repos,
      eventWriter: rig.deps.eventWriter,
      eventSink: rig.deps.eventSink,
      delivery: rig.delivery,
    }).publish(child.id, execution.id);
    const work = await rig.works.create({ projectId: rig.thread.projectId, name: "Revision" });
    await rebindThreadWork(
      {
        ...rig.repos,
        works: rig.works,
        workContextNotices: rig.delivery,
      },
      { threadId: rig.thread.id, workId: work.id },
    );
    await rig.run();
    await rig.run();
    expect(rig.requests).toHaveLength(4);
    const rendered = rig.requests.map((request) => JSON.stringify(request.messages));
    expect(rendered[1]).toContain("Request-only reminder.");
    expect(rendered[1]).toContain("Use distinctive dialogue.");
    expect(rendered[2]).toContain(`Subagent ${child.ref} finished`);
    expect(rendered[2]).toContain("Revision");
    expect(rendered[2]).not.toContain("Private report body");
    expect(new Set(rig.requests.map((request) => systemHash(request.messages))).size).toBe(1);
  });

  it("inherits a frozen prompt on default and same-Agent forks and handoff; only a different Agent rebakes", async () => {
    const rig = await fixture();
    await rig.run();
    const parent = await rig.repos.threads.findById(rig.thread.id);
    // The source's current Work differs from the Work captured by its first bake.
    const work = await rig.works.create({ projectId: rig.thread.projectId, name: "Later Work" });
    await rig.repos.threadWorks.rebindPrimary(rig.thread.id, work.id);
    for (const agentSelection of [undefined, rig.original.selection, rig.alternate.selection]) {
      const fork = await forkThreadAgent(rig.derive, {
        threadId: rig.thread.id,
        userId: rig.thread.userId,
        agentSelection,
      });
      const inherited = agentSelection !== rig.alternate.selection;
      expect(fork.bakedSkillSlugs).toEqual(inherited ? parent?.bakedSkillSlugs : null);
      expect(fork.bakedTools).toEqual(inherited ? parent?.bakedTools : null);
      expect(fork.agentDefinitionRevisionId).toBe(
        inherited
          ? rig.original.selection.definitionRevisionId
          : rig.alternate.selection.definitionRevisionId,
      );
      expect(fork.agentName).toBe(inherited ? "Writer" : "Editor");
      await rig.run(fork.id);
      const request = rig.requests[rig.requests.length - 1];
      expect(
        request.messages.some(
          (message) =>
            message.role === (inherited ? "user" : "system") &&
            message.content.some(
              (part) =>
                part.type === "text" && part.text.includes('current: later-work: "Later Work"'),
            ),
        ),
      ).toBe(true);
      expect(systemHash(request.messages) === systemHash(rig.requests[0].messages)).toBe(inherited);
      expect(
        request.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("<system_update>") &&
            JSON.stringify(message.content).includes("Forked conversation"),
        ),
      ).toBe(true);
    }
    const handoff = await handoffThreadAgent(rig.derive, {
      threadId: rig.thread.id,
      userId: rig.thread.userId,
      agentSelection: rig.original.selection,
      summary: "Continue the revision.",
    });
    await rig.run(handoff.id);
    const request = rig.requests[rig.requests.length - 1];
    expect(
      request.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) =>
              part.type === "text" && part.text.includes('current: later-work: "Later Work"'),
          ),
      ),
    ).toBe(true);
    expect(systemHash(request.messages)).toBe(systemHash(rig.requests[0].messages));
    expect(
      request.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message.content).includes("Handoff brief"),
      ),
    ).toBe(true);
  });

  it("does not promote a subagent-only binding into a primary fork", async () => {
    const rig = await fixture();
    const agent = await rig.derive.agentCatalog.save(rig.thread.userId, {
      slug: "helper",
      content: "---\nname: Helper\nmode: subagent\n---\n\nHelper.",
    });
    const child = await rig.repos.threads.createSubagent({
      userId: rig.thread.userId,
      projectId: rig.thread.projectId,
      parentThreadId: rig.thread.id,
      rootThreadId: rig.thread.id,
      spawnDepth: 1,
    });
    await rig.derive.agentRevisions.bindThread(
      child.id,
      agent.selection.definitionRevisionId,
      {
        model: "gpt-4.1-mini",
        skills: { load: [], available: [] },
        namedTargets: [],
      },
      null,
    );
    await rig.repos.turns.create({ threadId: child.id, role: "user", status: "complete" });
    for (const agentSelection of [undefined, agent.selection]) {
      await expect(
        forkThreadAgent(rig.derive, {
          threadId: child.id,
          userId: child.userId,
          agentSelection,
        }),
      ).rejects.toMatchObject({
        name: "AgentSelectionError",
        agentRef: agent.selection.definitionRevisionId,
      });
    }
    const fork = await forkThreadAgent(rig.derive, {
      threadId: child.id,
      userId: child.userId,
      agentSelection: rig.original.selection,
    });
    expect(fork.agentName).toBe("Writer");
  });

  it("leaves a default fork unfrozen when its parent has not made a request", async () => {
    const rig = await fixture();
    await rig.repos.turns.create({ threadId: rig.thread.id, role: "user", status: "complete" });
    const fork = await forkThreadAgent(rig.derive, {
      threadId: rig.thread.id,
      userId: rig.thread.userId,
    });
    expect(fork.bakedSkillSlugs).toBeNull();
    expect(fork.bakedTools).toBeNull();
    await rig.run(fork.id);
    const rebaked = await rig.repos.threads.findById(fork.id);
    expect(rebaked?.bakedSkillSlugs).toEqual([]);
    expect(rebaked?.bakedTools).not.toBeNull();
    const untouchedParent = await rig.repos.threads.findById(rig.thread.id);
    expect(untouchedParent?.bakedSkillSlugs).toBeNull();
    expect(untouchedParent?.bakedTools).toBeNull();
  });
});
