/** Cold handoff briefs use the same bake-aware source projection as model turns. */
import { expect, it } from "vitest";
import { createInMemoryRepositories, handoffSeedMetadata } from "../../threads/index.js";
import { createRuntimeHarness } from "./__tests__/runtime-harness.js";
import { scriptedSummarizer } from "./__tests__/scripted-summarizer.js";
import { createInertGateway } from "./__tests__/test-gateway.js";
import { generateHandoffBrief } from "./handoff-brief.js";

it.each([
  true,
  false,
])("gates cold compacted-source history guidance on its bake (%s)", async (historyReadable) => {
  const summarizer = scriptedSummarizer();
  // No source model is available: preview cannot supply a warm request.
  const r = createRuntimeHarness({
    summarizer,
    repos: createInMemoryRepositories(),
    gateway: { ...createInertGateway(), listModels: () => [] },
  });
  const source = await r.repos.threads.create({ projectId: "project", userId: "writer" });
  const { bake } = await r.repos.threads.bakeInitialPrompt(source.id, {
    composedSystemPrompt: "Source prompt",
    bakedTools: historyReadable ? [{ type: "function", name: "thread_history" }] : [],
    bakedSkillSlugs: [],
    contentHash: "source-bake",
  });
  const request = await r.repos.turns.create({
    threadId: source.id,
    role: "user",
    origin: "writer",
    status: "complete",
  });
  const c = await r.repos.turns.create({
    threadId: source.id,
    prevTurnId: request.id,
    role: "compaction",
    origin: "system",
    status: "complete",
    promptBakeId: bake.id,
    metadata: {
      kind: "compaction",
      compactedThrough: { turnId: request.id },
      pinnedRequestTurnIds: [request.id],
    },
  });
  await r.repos.blocks.create({
    turnId: c.id,
    blockType: "custom",
    sequence: 0,
    status: "complete",
    content: {
      kind: "compaction",
      props: {
        summary: "The jade gate is open.",
        excludedTurnCount: 1,
        tokensBefore: 100,
        tokensAfter: 20,
        model: "summary",
      },
    },
  });
  const destination = await r.repos.threads.create({
    projectId: source.projectId,
    userId: source.userId,
  });
  const seed = await r.repos.turns.create({
    threadId: destination.id,
    role: "system",
    origin: "system",
    status: "pending",
    metadata: handoffSeedMetadata({
      sourceThreadId: source.id,
      sourceRef: source.ref!,
      sourceTitle: source.title,
      cutoffTurnId: c.id,
      controlMessageId: crypto.randomUUID(),
    }),
  });
  const result = await generateHandoffBrief(
    r.deps,
    destination,
    seed,
    new AbortController().signal,
  );
  expect(result.outcome.kind).toBe("complete");
  expect(summarizer.calls).toHaveLength(1);
  expect(summarizer.calls[0].requestInHand).toBeNull();
  const text = JSON.stringify(summarizer.calls[0].projection);
  expect(text).toContain("The jade gate is open.");
  expect(text.includes("They remain readable with thread_history.")).toBe(historyReadable);
});
