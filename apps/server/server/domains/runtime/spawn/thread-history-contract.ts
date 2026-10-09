/** History tool contract: numbered turns, visibility, pagination, saved reports, document isolation and compaction. */

import { randomUUID } from "node:crypto";
import { ReadToolInputSchema, WriteToolInputSchema } from "@meridian/agent-edit/integration";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, JsonValue, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InternalThreadRepositories } from "../../threads/ports/repositories.js";
import { collectRecordedDocuments, planModelElisions } from "../loop/compaction/elide.js";
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
import { readThreadHistory, type ThreadHistoryInput } from "./thread-history.js";

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

      // A handoff starts its own lineage but may still read its direct source.
      const { thread: handoff } = await f.repos.threads.createDerivedPrimary({
        id: randomUUID() as ThreadId,
        userId: f.thread.userId,
        projectId: f.thread.projectId,
        workId: f.thread.workId,
        source: f.thread,
        originType: "handoff",
        originTurnId: second.id,
      });
      expect(handoff.rootThreadId).not.toBe(f.thread.rootThreadId);
      expect(output(await f.read({ ref: f.thread.ref ?? "" }, handoff))).toContain(
        "Conversation c1",
      );
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
    it.each([
      { include: ["routine_calls", "tool_results"] },
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
        expect(text).toContain("[search passages omitted; read a file for its current text]");
        expect(text).toContain("manuscript://chapter.md (1 match)");
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
