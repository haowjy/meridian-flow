/** Preview and execution use one retained definition and the same frozen host prompt. */
import { describe, expect, it } from "vitest";
import { createInMemoryAppServices } from "../../../../lib/compose.js";
import { testWorkSlug } from "../../../../test-support/work-slug.js";
import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "../system-instructions/document-dialect.js";
import { RUNTIME_URI_SYSTEM_INSTRUCTION } from "../system-instructions/runtime-uris.js";
import { assembleNextTurnContext } from "../turn-context-assembly.js";

async function fixture() {
  const app = createInMemoryAppServices();
  const source = {
    coordinate: "fixture/preparation",
    files: {
      "agents/writer.md": "---\nname: Writer\nmodel: original-model\n---\nRetained persona.",
    },
  };
  const revision = (await app.agentRevisions.installSource(source)).definitions[0];
  const created = await app.repos.threads.create({
    projectId: "project",
    userId: "user",
    currentAgent: "writer",
    systemPrompt: "Legacy override must not win.",
  });
  await app.agentRevisions.bindThread(created.id, revision.id);
  const thread = await app.repos.threads.findById(created.id);
  if (!thread) throw new Error("Missing fixture thread");
  const input = {
    thread,
    turns: [],
    blocks: [],
    agentRevisions: app.agentRevisions,
    toolRegistry: app.toolRegistry,
    bakeComposedSystemPrompt: app.repos.threads.bakeComposedSystemPrompt.bind(app.repos.threads),
    workContext: {
      async renderForThread() {
        return {
          text: "<work_context>\ntest\n</work_context>",
          current: {
            projectId: "00000000-0000-0000-0000-000000000001",
            execution: {
              scope: {
                kind: "work" as const,
                workId: "00000000-0000-0000-0000-000000000002",
                workSlug: testWorkSlug("test-work"),
              },
              aiWriteMode: "direct" as const,
              draftOwner: null,
            },
          },
        };
      },
    },
  };
  return { app, input, source, revision };
}

describe("assembleNextTurnContext", () => {
  it("previews the retained persona and generic host instructions exactly once without persisting", async () => {
    const { app, input } = await fixture();
    const assembled = await assembleNextTurnContext(input);
    expect(assembled.systemPrompt).toContain("Retained persona.");
    expect(assembled.systemPrompt).not.toContain("Legacy override");
    expect(assembled.systemPrompt.split(DOCUMENT_DIALECT_CORE_INSTRUCTION)).toHaveLength(2);
    expect(assembled.systemPrompt.split(RUNTIME_URI_SYSTEM_INSTRUCTION)).toHaveLength(2);
    expect(assembled.generateRequest.messages[0]?.content).toEqual([
      { type: "text", text: assembled.systemPrompt },
    ]);
    expect((await app.repos.threads.findById(input.thread.id))?.bakedSkillSlugs).toBeNull();
  });

  it("freezes once and retains model, body, and host prefix after catalog advancement", async () => {
    const { app, input, source, revision } = await fixture();
    await app.agentRevisions.selectRevision({
      ownerUserId: "user",
      logicalKey: "writer",
      revisionId: revision.id,
    });
    const first = await assembleNextTurnContext({ ...input, persistBake: true });
    const next = (
      await app.agentRevisions.installSource({
        ...source,
        files: {
          "agents/writer.md": "---\nname: Writer\nmodel: changed-model\n---\nChanged persona.",
        },
      })
    ).definitions[0];
    await app.agentRevisions.selectRevision({
      ownerUserId: "user",
      logicalKey: "writer",
      revisionId: next.id,
      expectedRevisionId: revision.id,
    });
    const reloaded = await app.repos.threads.findById(input.thread.id);
    if (!reloaded) throw new Error("Missing bound thread");
    const continued = await assembleNextTurnContext({
      ...input,
      thread: reloaded,
      persistBake: true,
    });
    expect(continued.systemPrompt).toBe(first.systemPrompt);
    expect(continued.generateRequest.model).toBe("original-model");
    expect(continued.agentSlug).toBe("writer");
    expect(continued.baked).toBe(true);
  });
});
