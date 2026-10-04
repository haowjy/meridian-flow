/** History tool contract: numbered turns, visibility, pagination, saved reports, document isolation and compaction. */

import { modelResult } from "@meridian/agent-edit";
import { ReadToolInputSchema, WriteToolInputSchema } from "@meridian/agent-edit/integration";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, JsonValue, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { handoffBriefFailedCopy, handoffSeedMetadata } from "../../threads/index.js";
import type { InternalThreadRepositories } from "../../threads/ports/repositories.js";
import { handoffSeedBlock } from "../handoff/seed.js";
import { collectRecordedDocuments, planModelElisions } from "../loop/compaction/elide.js";
import { estimateModelPartTokens } from "../loop/compaction/estimate.js";
import { WorkCommandSchema } from "../tools/core-tools.js";
import {
  historyDocumentText,
  readDocumentText,
  searchDocumentText,
  writeDocumentText,
} from "../tools/document-text.js";
import {
  documentHistorySummary,
  spawnHistorySummary,
  threadHistorySummary,
  workHistorySummary,
} from "../tools/history-summaries.js";
import { modelToolSchema } from "../tools/model-tool-schema.js";
import { SpawnInputSchema } from "../tools/spawn-tools.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import { type HistoryResult, renderHistoryResult } from "./history-result.js";
import {
  readThreadHistory,
  type ThreadHistoryInput,
  ThreadHistoryInputSchema,
} from "./thread-history.js";

export function defineThreadHistoryContract(
  createHarness: () => Promise<{
    repos: InternalThreadRepositories;
    projectId: ProjectId;
    userId: UserId;
  }>,
) {
  async function fixture() {
    const { repos, projectId, userId } = await createHarness();
    const root = await repos.threads.create({
      projectId,
      userId,
      title: "history",
    });
    const { thread, bake } = await repos.threads.bakeInitialPrompt(root.id, {
      composedSystemPrompt: "INITIAL PROMPT",
      bakedTools: [],
      bakedSkillSlugs: [],
      contentHash: "initial-hash",
    });
    const registry = createToolRegistry();
    const workKind = (input: JsonObject) =>
      input.command === "list" || input.command === "show" ? "routine" : "receipt";
    // Real input schemas: history orders stored arguments by them.
    for (const [name, documentText, historySummary, historyKind, schema] of [
      ["read", readDocumentText, documentHistorySummary, "routine", ReadToolInputSchema],
      ["write", writeDocumentText, documentHistorySummary, undefined, WriteToolInputSchema],
      ["search", searchDocumentText, undefined, "routine", undefined],
      ["ls", undefined, undefined, "routine", undefined],
      ["work", undefined, workHistorySummary, workKind, WorkCommandSchema],
      ["thread_history", historyDocumentText, threadHistorySummary, "routine", undefined],
      ["spawn", undefined, spawnHistorySummary, undefined, SpawnInputSchema],
      ["return_result", undefined, undefined, "routine", undefined],
    ] as const)
      registry.register({
        source: "core",
        definition: {
          type: "function",
          name,
          description: name,
          inputSchema: schema ? modelToolSchema(schema) : {},
        },
        input: z.unknown(),
        ...(documentText ? { documentText } : {}),
        ...(historySummary ? { historySummary } : {}),
        ...(historyKind ? { historyKind } : {}),
        ...(name === "return_result" ? { capability: "return_result" as const } : {}),
        execution: { type: "server", handler: async () => "" },
      });
    const read = (input: ThreadHistoryInput = {}, caller = thread) =>
      readThreadHistory({ repos, registry, caller, input, tokenizer: "anthropic" });
    async function turn(
      role: Turn["role"] = "assistant",
      metadata: JsonObject | null = null,
      status: Turn["status"] = "complete",
      origin: Turn["origin"] = role === "assistant" ? "assistant" : "system",
      threadId = thread.id,
    ) {
      return repos.turns.create({
        threadId,
        role,
        origin,
        status,
        metadata,
        prevTurnId: (await repos.turns.getLatestByThread(threadId))?.id,
      });
    }
    async function child() {
      const seed = await turn("user", null, "complete", "writer");
      return repos.threads.createSubagent({
        projectId,
        userId,
        parentThreadId: thread.id,
        rootThreadId: thread.id,
        originTurnId: seed.id,
        spawnDepth: 1,
        title: "child",
      });
    }
    const sequences = new Map<string, number>();
    async function block(t: Turn, type: Block["blockType"], content: Block["content"]) {
      const sequence = sequences.get(t.id) ?? 0;
      sequences.set(t.id, sequence + 1);
      return repos.blocks.create({
        turnId: t.id,
        blockType: type,
        sequence,
        content,
        ...(typeof content === "string" ? { textContent: content } : {}),
      });
    }
    async function tool(
      t: Turn,
      name: string,
      input: JsonObject,
      output: JsonValue,
      isError = false,
      /** The typed result beside the rendered `output` (D43); absent on older rows. */
      typed?: JsonValue,
    ) {
      const toolCallId = crypto.randomUUID();
      const call = await block(t, "tool_use", { toolCallId, toolName: name, input });
      const result = await block(t, "tool_result", {
        toolCallId,
        toolName: name,
        output,
        ...(typed !== undefined ? { result: typed } : {}),
        isError,
        metadata: {
          documentRevisions: [
            { documentId: "doc", uri: "manuscript://chapter.md", revision: "v1" },
          ],
        },
      });
      return { call, result };
    }
    async function text(t: Turn, content: string) {
      return block(t, "text", content);
    }
    return { repos, thread, bake, read, turn, block, tool, text, registry, child };
  }
  function structured(result: Awaited<ReturnType<typeof readThreadHistory>>): HistoryResult {
    expect(result).toHaveProperty("output");
    if (!("output" in result)) throw new Error("History read failed");
    return result.output;
  }
  function output(result: Awaited<ReturnType<typeof readThreadHistory>>): string {
    return renderHistoryResult(structured(result));
  }
  function cursor(text: string) {
    const call = text.match(/^More: thread_history\(([^\n]+)\)$/mu)?.[1];
    return call ? JSON.parse(call).cursor : undefined;
  }
  function nextCall(text: string): ThreadHistoryInput {
    const call = text.match(/^More: thread_history\(([^\n]+)\)$/mu)?.[1];
    if (!call) throw new Error("History output has no next call");
    return ThreadHistoryInputSchema.parse(JSON.parse(call));
  }

  describe("thread_history", () => {
    it("batches pairs across page boundaries and scopes reused call ids to their turn", async () => {
      const f = await fixture();
      const first = await f.turn();
      for (let index = 0; index < 199; index++)
        await f.block(first, "reasoning", { text: "hidden" });
      await f.block(first, "tool_use", {
        toolCallId: "reused",
        toolName: "read",
        input: { path: "manuscript://first.md" },
      });
      await f.block(first, "tool_result", { toolCallId: "reused", output: "FIRST SECRET" });
      const second = await f.turn();
      await f.block(second, "tool_use", {
        toolCallId: "reused",
        toolName: "read",
        input: { path: "manuscript://second.md" },
      });
      await f.block(second, "tool_result", { toolCallId: "reused", output: "SECOND SECRET" });
      const batches = vi.spyOn(f.repos.blocks, "listToolBlocks");
      const text = output(
        await f.read({ order: "oldest_first", include: ["routine_calls", "tool_results"] }),
      );
      expect(text).toContain('read({"path":"manuscript://first.md"})');
      expect(text).toContain('read({"path":"manuscript://second.md"})');
      expect(text).not.toContain("FIRST SECRET");
      expect(text).not.toContain("SECOND SECRET");
      // The repository boundary has one pair read per raw page, never per item.
      expect(batches).toHaveBeenCalledTimes(2);
      expect(batches.mock.calls[0]?.[0]).toEqual([{ turnId: first.id, toolCallId: "reused" }]);
      expect(batches.mock.calls[1]?.[0]).toEqual([
        { turnId: first.id, toolCallId: "reused" },
        { turnId: second.id, toolCallId: "reused" },
      ]);
      batches.mockRestore();
    });

    it("labels writer, steer, agent request, spawn prompt, assistant, thinking, completion, seed and failed C", async () => {
      const f = await fixture();
      const cases: [Turn["role"], Turn["origin"], JsonObject | null, string][] = [
        ["user", "writer", null, "user"],
        ["user", "writer", { delivery: "steer" }, "user, steer"],
        ["user", "system", { kind: "inbox_message", inboxMessageId: "m" }, "agent"],
        [
          "user",
          "system",
          { kind: "inbox_message", inboxMessageId: "n", agentRequestKind: "child_seed" },
          "agent, spawn prompt",
        ],
        ["assistant", "assistant", null, "assistant"],
        [
          "system",
          "system",
          {
            kind: "subagent_update",
            handle: "p4",
            outcome: "succeeded",
            execution: "execution",
            childThreadId: "child",
            agentName: "Helper",
          },
          "system: child p4 finished (succeeded)",
        ],
        [
          "user",
          "system",
          { kind: "system_update", section: "work_context" },
          "system: Work update",
        ],
        [
          "system",
          "system",
          { kind: "derivation_seed", derivation: "handoff" },
          "system: fork_or_handoff_seed",
        ],
      ];
      for (const [role, origin, metadata, label] of cases) {
        const t = await f.turn(role, metadata, "complete", origin);
        await f.text(t, `text-${label}`);
      }
      await f.turn(
        "compaction",
        { kind: "compaction", failure: { reason: "provider_error", phase: "summary" } },
        "error",
      );
      const response = await f.turn();
      await f.block(response, "reasoning", { text: "thinking-secret" });
      const defaults = output(await f.read({ order: "oldest_first" }));
      expect(defaults).toContain("[1] user\ntext-user");
      expect(defaults).toContain("[3] agent\n");
      expect(defaults).not.toContain("thinking-secret");
      expect(defaults).not.toContain("system:");
      const all = output(
        await f.read({ order: "oldest_first", include: ["system_messages", "thinking"] }),
      );
      // Conversation turns are numbered without gaps; system turns carry no number.
      for (const [index, [, , , label]] of cases.slice(0, 5).entries())
        expect(all).toContain(`[${index + 1}] ${label}\n`);
      for (const [, , , label] of cases.slice(5))
        expect(all).toMatch(new RegExp(`^${label.replace(/[()]/gu, "\\$&")}\n`, "mu"));
      expect(all).toContain("Thinking:\nthinking-secret");
      expect(all).toContain("\n\nsystem: compaction\nerror");
      expect(all).toContain("[6] assistant\nThinking:\nthinking-secret");
    });
    it.each([
      "complete",
      "error",
    ] as const)("labels C7b's %s handoff seed as system history", async (status) => {
      const f = await fixture();
      const seed = await f.turn(
        "system",
        handoffSeedMetadata({
          sourceThreadId: f.thread.id,
          sourceRef: f.thread.ref ?? "c1",
          sourceTitle: f.thread.title,
          cutoffTurnId: crypto.randomUUID(),
        }),
        status,
      );
      const brief =
        status === "complete" ? { text: "The gate is open.", model: "summary" } : undefined;
      const card = handoffSeedBlock(seed, brief);
      await f.block(seed, "custom", card.content);
      if (status === "error")
        await f.repos.turns.updateStatus(seed.id, { status, error: handoffBriefFailedCopy });
      expect(output(await f.read())).not.toContain("handoff-brief");
      const text = output(await f.read({ include: ["system_messages"] }));
      expect(text).toMatch(/^system: fork_or_handoff_seed$/mu);
      expect(text).toContain("<system_update>");
      expect(text).not.toContain('"kind":"handoff-brief"');
      expect(text).not.toContain(f.thread.id);
      expect(text).toContain(status === "complete" ? "The gate is open." : "with no brief.");
      if (status === "error") expect(text).toContain(`error: ${handoffBriefFailedCopy}`);
    });

    it("renders a thread-reference component as its model text without internal ids", async () => {
      const f = await fixture();
      const seed = await f.turn("user", {
        kind: "inbox_message",
        inboxMessageId: "seed",
        agentRequestKind: "child_seed",
      });
      const threadId = crypto.randomUUID();
      const modelText =
        '<thread_reference ref="c1">\nRead it with thread_history({"ref":"c1"}).\n</thread_reference>';
      await f.block(seed, "custom", {
        kind: "thread-reference",
        props: {
          ref: "c1",
          text: modelText,
          title: "Source",
          threadId,
          agentName: "General",
          lastActivityAt: "2026-09-30T12:00:00.000Z",
        },
      });

      const text = output(await f.read({ order: "oldest_first" }));
      expect(text).toContain(modelText);
      expect(text).not.toContain(threadId);
      expect(text).not.toContain('"kind":"thread-reference"');
    });

    it("keeps a failed reply labelled assistant with its error after a later writer turn", async () => {
      const f = await fixture();
      const failed = await f.turn("assistant", { reason: "image_resolution_failed" }, "error");
      await f.text(failed, "Partial scene.");
      await f.repos.turns.updateStatus(failed.id, {
        status: "error",
        error: "This response failed.",
      });
      await f.text(await f.turn("user", null, "complete", "writer"), "Move on.");
      const text = output(await f.read({ order: "oldest_first" }));
      expect(text).toContain(
        "[1] assistant\nPartial scene.\nerror: This response failed.\nfailure reason: image_resolution_failed",
      );
      expect(text).toContain("[2] user\nMove on.");
    });

    it("drops the header noise: no Agent, order, dates, ranges or segment header", async () => {
      const f = await fixture();
      await f.text(await f.turn("user", null, "complete", "writer"), "pizza");
      const text = output(await f.read());
      expect(text).toBe(`Conversation ${f.thread.ref}\n\n[1] user\npizza`);
    });

    it("marks compacted turns and keeps every number across compaction and order", async () => {
      const f = await fixture();
      const before = await f.turn("user", null, "complete", "writer");
      await f.text(before, "before");
      const reply = await f.turn();
      await f.text(reply, "reply");
      const precompaction = output(await f.read({ order: "oldest_first" }));
      expect(precompaction).toContain("[1] user\nbefore");
      expect(precompaction).toContain("[2] assistant\nreply");
      const next = await f.repos.promptBakes.create({
        ownerThreadId: f.thread.id,
        composedSystemPrompt: "NEW PROMPT",
        bakedTools: [],
        bakedSkillSlugs: [],
        contentHash: "new-hash",
      });
      const c = await f.repos.turns.create({
        threadId: f.thread.id,
        role: "compaction",
        origin: "system",
        status: "complete",
        promptBakeId: next.id,
        prevTurnId: reply.id,
        compactionModel: "mock",
        metadata: {
          kind: "compaction",
          compactedThrough: { turnId: reply.id },
          pinnedRequestTurnIds: [],
          instructions: "Emphasize the broken oath.",
        },
      });
      await f.block(c, "custom", { kind: "compaction", props: { summary: "summary" } });
      const later = await f.turn("user", null, "complete", "writer");
      await f.text(later, "after");

      const newest = output(await f.read());
      expect(newest).toContain("[earlier turns summarized]\n\n[3] user\nafter");
      expect(newest).not.toContain("before");
      const older = output(await f.read({ cursor: cursor(newest) }));
      expect(older).toContain("[1] user\nbefore");
      expect(older).toContain("[2] assistant\nreply");
      expect(older).not.toContain("summarized");

      const first = output(await f.read({ order: "oldest_first", include: ["system_prompt"] }));
      expect(first).toContain("System prompt:\nINITIAL PROMPT\n\n[1] user\nbefore");
      expect(first).not.toContain("after");
      const second = output(
        await f.read({
          order: "oldest_first",
          include: ["system_prompt", "system_messages"],
          cursor: cursor(first),
        }),
      );
      expect(second).toContain("System prompt:\nNEW PROMPT");
      expect(second).not.toContain("bake");
      expect(second).not.toContain("new-hash");
      expect(second).toContain(
        "[earlier turns summarized]\n\nsystem: compaction\ninstructions: Emphasize the broken oath.",
      );
      expect(second).toContain("[3] user\nafter");
      // The expand handle is the same turn number in either order.
      expect(output(await f.read({ expand: 3 }))).toContain("[3] user\n3.1 after");
    });

    it.each([
      "oldest_first",
      "newest_first",
    ] as const)("numbers %s turns without gaps around a hidden system turn", async (order) => {
      const f = await fixture();
      await f.text(await f.turn("user", null, "complete", "writer"), "check on p4");
      await f.text(
        await f.turn("system", {
          kind: "subagent_update",
          handle: "p4",
          outcome: "succeeded",
          execution: "execution",
          childThreadId: "child",
          agentName: "Helper",
        }),
        "p4 finished",
      );
      await f.text(
        await f.turn("user", { kind: "system_update", section: "work_context" }),
        "Work",
      );
      await f.text(await f.turn(), "p4 is done");
      await f.text(await f.turn("user", null, "complete", "writer"), "thanks");
      const text = output(await f.read({ order }));
      expect(text).toBe(`Conversation ${f.thread.ref}

[1] user
check on p4

[2] assistant
p4 is done

[3] user
thanks`);
      for (const limit of [1, 2]) {
        const numbers: (number | undefined)[] = [];
        let next: string | undefined;
        do {
          const page = structured(await f.read({ order, limit, cursor: next }));
          numbers.push(...page.turns.map((turn) => turn.number));
          next = page.next?.call.cursor;
        } while (next);
        expect([...numbers].sort()).toEqual([1, 2, 3]);
      }
      expect(output(await f.read({ expand: 2 }))).toContain("[2] assistant\n2.1 p4 is done");
      expect(output(await f.read({ expand: 3 }))).toContain("[3] user\n3.1 thanks");
    });

    it("gives a turn the same number in newest_first and oldest_first pages", async () => {
      const f = await fixture();
      for (let index = 1; index <= 6; index++) await f.text(await f.turn(), `reply ${index}`);
      const newest = output(await f.read({ limit: 2 }));
      expect(newest).toContain("[5] assistant\nreply 5\n\n[6] assistant\nreply 6");
      const oldest = output(await f.read({ order: "oldest_first", limit: 2 }));
      expect(oldest).toContain("[1] assistant\nreply 1\n\n[2] assistant\nreply 2");
    });

    it("hides routine calls behind a count and writes each visible call as the call itself", async () => {
      const f = await fixture();
      await f.text(await f.turn("user", null, "complete", "writer"), "pizza");
      const t = await f.turn();
      await f.text(t, 'I looked around to see what "pizza" might point at.');
      for (let index = 0; index < 9; index++)
        await f.tool(t, "read", { path: `manuscript://ch${index}.md` }, `chapter ${index}`);
      await f.tool(t, "ls", {}, "folders");
      const content = `Pizza night at the inn, and ${"the cook argued with the guard ".repeat(30)}`;
      await f.tool(
        t,
        "write",
        { command: "create", path: "manuscript://notes.md", content },
        "status: success",
        false,
        modelResult({
          command: "create",
          status: "success",
          phase: "committed",
          payload: { write: { id: "w1" }, destination: "draft", draftWork: "rewrite" },
        }) as unknown as JsonValue,
      );
      await f.tool(
        t,
        "read",
        { path: "manuscript://missing.md" },
        "status: document_not_found\n\nNo document at manuscript://missing.md",
        true,
        modelResult({ command: "read", status: "document_not_found" }) as unknown as JsonValue,
      );
      await f.tool(
        t,
        "spawn",
        { agent: "critic", name: "Pacing review", prompt: "Read chapter 3 for pacing." },
        "Subagent p8 is running.",
        false,
        { status: "background", handle: "p8", threadId: "child", agentSlug: "critic" },
      );
      await f.tool(t, "work", { command: "create", name: "Rewrite" }, "{}", false, {
        slug: "rewrite",
      });
      await f.tool(t, "work", { command: "list" }, "[]", false, [{ slug: "rewrite" }]);
      const text = output(await f.read());
      const ref = f.thread.ref;
      expect(text).toBe(`Conversation ${ref}

[1] user
pizza

[2] assistant
I looked around to see what "pizza" might point at.
write({"command":"create","path":"manuscript://notes.md","content":"Pizza night at the inn, and the cook…(186 words)"}) → w1, 186 words, version: draft (@rewrite)
read({"path":"manuscript://missing.md"}) → failed: document_not_found
status: document_not_found

No document at manuscript://missing.md
spawn({"agent":"critic","prompt":"Read chapter 3 for pacing.","name":"Pacing review"}) → p8
work({"command":"create","name":"Rewrite"}) → @rewrite
(11 routine tool calls hidden; list them with thread_history({"ref":"${ref}","expand":2}))`);
      const routine = output(await f.read({ include: ["routine_calls"] }));
      expect(routine).toContain('read({"path":"manuscript://ch0.md"})\n');
      expect(routine).toContain("ls({})\n");
      expect(routine).toContain('work({"command":"list"}) → 1 Work');
      expect(routine).not.toContain("hidden");
      const expanded = output(await f.read({ expand: 2 }));
      expect(expanded).toContain(
        '2.12 write({"command":"create","path":"manuscript://notes.md","content":"Pizza night at the inn, and the cook…(186 words)"}) → w1, 186 words, version: draft (@rewrite) (',
      );
      expect(expanded).toContain("2.11 ls({}) (");
      // One call in full keeps the whole arguments as an edit record.
      const one = output(await f.read({ expand: "2.12" }));
      expect(one).toContain("edit record from");
      expect(one).toContain(content.trim());
    });

    it("shows timestamps only on request", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.text(t, "first");
      const date = t.createdAt.slice(0, 10);
      expect(output(await f.read())).not.toContain(date);
      expect(output(await f.read({ include: ["timestamps"] }))).toContain(
        `[1] assistant  ${t.createdAt.slice(0, 16).replace("T", " ")}\nfirst`,
      );
    });

    it("limit counts turns; hidden calls never count toward it", async () => {
      const f = await fixture();
      for (let turn = 1; turn <= 3; turn++) {
        const t = await f.turn();
        await f.text(t, `reply ${turn}`);
        for (let i = 0; i < 30; i++) await f.tool(t, "ls", {}, `hidden-${i}`);
      }
      const first = output(await f.read({ order: "oldest_first", limit: 2 }));
      expect(first).toContain("[1] assistant\nreply 1\n(30 routine tool calls hidden");
      expect(first).toContain("[2] assistant\nreply 2\n(30 routine tool calls hidden");
      expect(first).not.toContain("reply 3");
      expect(first).not.toContain("hidden-");
      const second = output(
        await f.read({ order: "oldest_first", limit: 2, cursor: cursor(first) }),
      );
      expect(second).toContain("[3] assistant\nreply 3\n(30 routine tool calls hidden");
      expect(cursor(second)).toBeUndefined();
    });

    it.each([
      "oldest_first",
      "newest_first",
    ] as const)("pages %s over hidden calls with no gaps and no repeats", async (order) => {
      const f = await fixture();
      for (let turn = 1; turn <= 12; turn++) {
        const t = await f.turn();
        await f.tool(t, "read", { path: `manuscript://a${turn}.md` }, "copy");
        await f.text(t, `reply ${turn}`);
        await f.tool(t, "search", { pattern: "x" }, []);
      }
      const seen: number[] = [];
      let hidden = 0;
      let next: string | undefined;
      do {
        const page = structured(await f.read({ order, limit: 5, cursor: next }));
        for (const turn of page.turns) {
          seen.push(turn.number ?? 0);
          hidden += turn.hiddenCount;
          expect(turn.items).toEqual([expect.objectContaining({ text: `reply ${turn.number}` })]);
        }
        next = page.next?.call.cursor;
      } while (next);
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(hidden).toBe(24);
    });

    it.each([
      "oldest_first",
      "newest_first",
    ] as const)("prints a complete More call that continues %s verbatim", async (order) => {
      const f = await fixture();
      await f.text(await f.turn(), "first");
      await f.text(await f.turn(), "second");
      const firstPage = output(
        await f.read({ order, limit: 1, include: ["thinking", "system_messages"] }),
      );
      const call = nextCall(firstPage);
      const next = call.cursor as string;
      expect(call).toEqual({
        ref: f.thread.ref,
        order,
        cursor: next,
        limit: 1,
        include: ["thinking", "system_messages"],
      });
      expect(next).toMatch(
        new RegExp(
          `^c\\d+:${order === "oldest_first" ? "o" : "n"}\\d+(?:\\.\\d+)?@\\d+(?:\\.\\d+)?~[a-f0-9]{8}$`,
          "u",
        ),
      );
      const secondPage = output(await f.read(call));
      expect(secondPage).toContain(
        order === "oldest_first" ? "[2] assistant\nsecond" : "[1] assistant\nfirst",
      );
      expect(secondPage).not.toContain(order === "oldest_first" ? "first" : "second");
      for (const [candidate, message] of [
        [next.replace(/^c\d+/u, "p99"), "another conversation"],
        [
          next.replace(
            order === "oldest_first" ? ":o" : ":n",
            order === "oldest_first" ? ":n" : ":o",
          ),
          "another history order",
        ],
        [next.replace(/@(\d+)/u, (_, anchor) => `@${Number(anchor) + 999}`), "anchor"],
      ] as const) {
        expect(await f.read({ order, cursor: candidate })).toMatchObject({
          ok: false,
          error: { code: "invalid_cursor", message: expect.stringContaining(message) },
        });
      }
    });
    it.each([
      "oldest_first",
      "newest_first",
    ] as const)("CJK token-cap resumes inside a turn without gaps in %s", async (order) => {
      const f = await fixture();
      const t = await f.turn();
      for (let i = 0; i < 20; i++) await f.text(t, `${i}: ${"龍".repeat(600)}`);
      const seen: string[] = [];
      let next: string | undefined;
      do {
        const text = output(await f.read({ order, cursor: next }));
        expect(text).toContain("[1] assistant\n");
        seen.push(...[...text.matchAll(/^(\d+): 龍/gmu)].map((m) => m[1] as string));
        next = cursor(text);
      } while (next);
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
    });
    it("caps a long message at the item limit with a copyable item handle", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.tool(t, "read", { path: "manuscript://ch1.md" }, "copy");
      await f.text(t, `${"long sentence ".repeat(3000)}END`);
      const text = output(await f.read());
      expect(text).not.toContain("END");
      expect(text).toContain(
        `(truncated: thread_history({"ref":"${f.thread.ref}","expand":"1.2"}))`,
      );
      const full = output(await f.read({ expand: "1.2" }));
      expect(full).toContain("[1] assistant\n1.2 message\n");
      expect(full).toContain("END");
    });
    it("expands a turn of ten chapter reads one line each, within the page budget", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.text(t, "Reading the arc.");
      for (let i = 1; i <= 10; i++)
        await f.tool(t, "read", { path: `manuscript://ch${i}.md` }, `${"prose ".repeat(4000)}`);
      for (const expand of [1, "1"] as const) {
        const text = output(await f.read({ expand }));
        expect(text).toContain(
          '[1] assistant\n1.1 Reading the arc.\n1.2 read({"path":"manuscript://ch1.md"}) (',
        );
        expect(text).toMatch(
          /^1\.11 read\(\{"path":"manuscript:\/\/ch10\.md"\}\) \([\d,]+ tokens\)$/mu,
        );
        expect(text).not.toContain("prose");
        expect(estimateModelPartTokens({ type: "text", text }, "anthropic")).toBeLessThan(8000);
      }
      const one = output(await f.read({ expand: "1.3" }));
      expect(one).toContain(
        '1.3 read({"path":"manuscript://ch2.md"})\n{"path":"manuscript://ch2.md"}',
      );
      // A document copy stays elided even in full.
      expect(one).not.toContain("prose");
    });
    it("shows a child's saved report on its terminal turn instead of the return_result arguments", async () => {
      const f = await fixture();
      const child = await f.child();
      await f.text(
        await f.turn(
          "user",
          { kind: "inbox_message", inboxMessageId: "s", agentRequestKind: "child_seed" },
          "complete",
          "system",
          child.id,
        ),
        "Summarize the conversation so far.",
      );
      const terminal = await f.turn("assistant", null, "complete", "assistant", child.id);
      await f.text(terminal, "Here is the summary.");
      await f.tool(terminal, "return_result", { summary: "ARGUMENT SUMMARY" }, { ok: true });
      await f.repos.executionReports.admit({
        childThreadId: child.id as ThreadId,
        executionTurnId: terminal.id as TurnId,
        handle: child.ref as string,
        origin: "thread_run",
        deliveryMode: "none",
        callerThreadId: null,
        callerTurnId: null,
        toolCallId: null,
        cardBlockId: null,
      });
      await f.repos.executionReports.finalizeOnce({
        terminalTurnId: terminal.id as TurnId,
        childThreadId: child.id as ThreadId,
        executionTurnId: terminal.id as TurnId,
        outcome: "failed",
        reason: "ran out of turns",
        source: "final_assistant",
        summary: Array.from({ length: 25 }, (_, i) => `SAVED LINE ${i + 1}`).join("\n"),
      });
      const text = output(await f.read({}, child));
      expect(text).toContain(
        "[2] assistant\nHere is the summary.\nReport (failed, final_assistant)\nreason: ran out of turns\nSAVED LINE 1\n",
      );
      expect(text).toContain("SAVED LINE 20\n");
      expect(text).not.toContain("SAVED LINE 21");
      expect(text).toContain(
        `(report truncated: thread_history({"ref":"${child.ref}","expand":2}))\n(1 routine tool call hidden; list it with thread_history({"ref":"${child.ref}","expand":2}))`,
      );
      expect(text).not.toContain("ARGUMENT SUMMARY");
      const expanded = output(await f.read({ expand: 2 }, child));
      expect(expanded).toContain("2.2 return_result(…)");
      expect(expanded).toContain("SAVED LINE 25");
      expect(expanded).not.toContain("ARGUMENT SUMMARY");
    });
    it("lists running work under In progress, outside the cursor", async () => {
      const f = await fixture();
      await f.text(await f.turn("user", null, "complete", "writer"), "test a subagent");
      const live = await f.turn("assistant", null, "streaming");
      await f.block(live, "tool_use", {
        toolCallId: "spawn-1",
        toolName: "spawn",
        input: { agent: "general", name: "Summarize conversation test" },
      });
      const result = structured(await f.read());
      expect(result.next).toBeUndefined();
      expect(renderHistoryResult(result)).toBe(`Conversation ${f.thread.ref}

[1] user
test a subagent

In progress
[2] spawn({"agent":"general","name":"Summarize conversation test"}) → running`);
    });
    it.each([
      {},
      { include: ["routine_calls", "tool_results"] },
      { include: ["routine_calls", "tool_results", "system_messages"] },
    ] as ThreadHistoryInput[])("stubs copies, and a write line carries edit evidence: %j", async (input) => {
      const f = await fixture();
      const t = await f.turn();
      await f.tool(t, "read", { path: "manuscript://chapter.md" }, "COPY SENTINEL");
      await f.tool(t, "search", { pattern: "Dragon" }, [
        {
          uri: "manuscript://chapter.md",
          matches: [{ excerpt: "COPY SENTINEL", line: 1 }],
          matchCount: 1,
        },
      ]);
      await f.tool(
        t,
        "write",
        {
          command: "replace",
          path: "manuscript://chapter.md",
          find: "old",
          content: "EDIT SENTINEL",
        },
        "COPY SENTINEL",
      );
      const writer = await f.turn("user", null, "complete", "writer");
      await f.block(writer, "text", {
        type: "reference",
        documentId: "11111111-1111-4111-8111-111111111111",
        uri: "manuscript://chapter.md",
        text: "@chapter",
        read: { result: "COPY SENTINEL", revision: "y1:reference-revision" },
      } as JsonObject);
      const result = await f.read(input);
      const text = output(result);
      expect(text).not.toContain("COPY SENTINEL");
      expect(text).not.toContain("y1:");
      expect(text).not.toContain('"revision"');
      // The call line quotes the edit's inputs, so the page carries their evidence (D48).
      expect(text).toContain(
        'write({"command":"replace","path":"manuscript://chapter.md","content":"EDIT SENTINEL","find":"old"})',
      );
      expect(text).not.toContain("edit record from");
      expect(result).toMatchObject({
        metadata: { documentRevisions: [{ documentId: "doc", revision: null }] },
      });
      expect(await f.read({ expand: 1 })).toMatchObject({
        metadata: { documentRevisions: [{ documentId: "doc", revision: null }] },
      });
      if (input.include?.includes("tool_results")) {
        expect(text).toContain('"omitted":"read it for current text"');
        expect(text).not.toContain('"matches"');
      }
      for (const handle of ["1.1", "1.2", "1.3"])
        expect(output(await f.read({ expand: handle }))).not.toContain("COPY SENTINEL");
      const edit = await f.read({ expand: "1.3" });
      expect(output(edit)).toContain("EDIT SENTINEL");
      expect(output(edit)).toContain("edit record from");
      expect(edit).toMatchObject({
        metadata: { documentRevisions: [{ documentId: "doc", revision: null }] },
      });
    });
    it("isError write output is verbatim and quoted edits clear at compaction, empty evidence stays", async () => {
      const quiet = await fixture();
      await quiet.text(await quiet.turn(), "no edits here");
      const plain = await quiet.read();
      const f = await fixture();
      const t = await f.turn();
      await f.tool(
        t,
        "write",
        { command: "replace", content: "rejected edit", path: "manuscript://chapter.md" },
        "Write did not land: ERROR SENTINEL",
        true,
      );
      expect(output(await f.read())).toContain(
        'write({"command":"replace","path":"manuscript://chapter.md","content":"rejected edit"}) → failed\nWrite did not land: ERROR SENTINEL',
      );
      for (const result of [await f.read(), await f.read({ expand: 1 }), plain]) {
        const r = await f.turn();
        const call = await f.block(r, "tool_use", {
          toolCallId: "history",
          toolName: "thread_history",
          input: {},
        });
        const out = await f.block(r, "tool_result", {
          toolCallId: "history",
          toolName: "thread_history",
          ...result,
        } as JsonObject);
        const slices = [{ turn: r, blocks: [call, out] }];
        const policies = (name: string) => f.registry.getRegistration(name)?.documentText;
        const elisions = planModelElisions({
          retainedSuffix: slices,
          recorded: collectRecordedDocuments(slices, policies),
          current: new Map(),
          policies,
        });
        if (result !== plain)
          expect(JSON.stringify(elisions)).toContain("thread_history output quoting edits");
        else expect(elisions).toEqual([]);
      }
    });
    it("stubs an orphan tool result rather than leaking a document copy", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.block(t, "tool_result", {
        toolCallId: "missing-call",
        output: "ORPHAN COPY SENTINEL",
      });
      const text = output(await f.read({ include: ["tool_results"] }));
      expect(text).not.toContain("ORPHAN COPY SENTINEL");
      expect(text).toContain("call unavailable");
    });
    it("bounds scans of a hidden-only segment and resumes beyond it", async () => {
      const f = await fixture();
      const t = await f.turn();
      for (let i = 0; i < 2001; i++) await f.block(t, "reasoning", { text: "hidden" });
      await f.text(t, "visible after scan budget");
      const first = output(await f.read({ order: "oldest_first" }));
      expect(first).not.toContain("visible after scan budget");
      expect(cursor(first)).toBeDefined();
      const second = output(await f.read({ order: "oldest_first", cursor: cursor(first) }));
      expect(second).toContain("[1] assistant\nvisible after scan budget");
    });
    it("prints system_prompt only when a cursor opens a segment", async () => {
      const f = await fixture();
      await f.text(await f.turn(), "first");
      await f.text(await f.turn(), "second");
      const first = output(
        await f.read({ order: "oldest_first", limit: 1, include: ["system_prompt"] }),
      );
      const next = output(
        await f.read({
          order: "oldest_first",
          limit: 1,
          include: ["system_prompt"],
          cursor: cursor(first),
        }),
      );
      expect(first).toContain("System prompt:\nINITIAL PROMPT");
      expect(next).not.toContain("INITIAL PROMPT");
      expect(next).toContain("[2] assistant\nsecond");
    });
    it("keeps assistant UI cards out of the default prose view", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.block(t, "custom", {
        kind: "helper-result",
        props: { summary: "saved child report" },
      });
      expect(output(await f.read())).not.toContain("saved child report");
      expect(output(await f.read({ include: ["system_messages"] }))).toContain(
        "system: helper-result",
      );
    });
    it("labels component cards without serializing their internal props", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.block(t, "custom", {
        kind: "helper-result",
        props: {
          agentSlug: "critic",
          agentName: "Critic",
          parentTurnId: "secret-parent-id",
          toolCallId: "secret-call-id",
          deliveryMode: "direct",
          childThreadId: "secret-child-id",
          execution: "secret-execution-id",
          startedAt: "2026-01-01T00:00:00.000Z",
          terminalAt: "2026-01-01T00:01:00.000Z",
          outcome: "succeeded",
        },
      });
      await f.block(t, "custom", {
        kind: "helper-result",
        props: {
          agentSlug: "scout",
          agentName: "Scout",
          parentTurnId: "secret-running-parent-id",
          toolCallId: "secret-running-call-id",
          deliveryMode: "background_notification",
          childThreadId: "secret-running-child-id",
          execution: null,
          startedAt: "2026-01-01T00:02:00.000Z",
          terminalAt: null,
        },
      });
      const text = output(await f.read({ include: ["system_messages"] }));
      expect(text).toContain('Subagent "Critic" finished (succeeded).');
      expect(text).toContain('Subagent "Scout" is running.');
      expect(text).not.toContain("secret-");
      expect(text).not.toContain('"props"');
    });
    it("returns structured cursor and item errors", async () => {
      const f = await fixture();
      await f.text(await f.turn(), "only turn");
      expect(await f.read({ cursor: "bad" })).toMatchObject({
        ok: false,
        error: { code: "invalid_cursor" },
      });
      for (const expand of [999, "999", "999.1", "1.9"])
        expect(await f.read({ expand })).toMatchObject({
          ok: false,
          error: { code: "item_not_found" },
        });
    });
  });
}
