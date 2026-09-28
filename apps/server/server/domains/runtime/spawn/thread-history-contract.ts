/** History tool contract: projection, pagination, document isolation and compaction evidence. */
import type { ProjectId, UserId } from "@meridian/contracts/runtime";
import type { Block, JsonObject, JsonValue, Turn } from "@meridian/contracts/threads";
import { describe, expect, it, vi } from "vitest";
import type { InternalThreadRepositories } from "../../threads/ports/repositories.js";
import { collectRecordedDocuments, planModelElisions } from "../loop/compaction/elide.js";
import {
  historyDocumentText,
  searchDocumentText,
  writeDocumentText,
} from "../tools/document-text.js";
import { writeHistoryPreview } from "../tools/history-previews.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import { readThreadHistory } from "./thread-history.js";

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
    for (const [name, documentText] of [
      ["write", writeDocumentText],
      ["search", searchDocumentText],
      ["thread_history", historyDocumentText],
    ] as const)
      registry.register({
        source: "core",
        definition: { type: "function", name, description: name, inputSchema: {} },
        documentText,
        historyPreview: name === "write" ? writeHistoryPreview : undefined,
        execution: { type: "server", handler: async () => "" },
      });
    const read = (input = {}) =>
      readThreadHistory({ repos, registry, caller: thread, input, tokenizer: "anthropic" });
    async function turn(
      role: Turn["role"] = "assistant",
      metadata: JsonObject | null = null,
      status: Turn["status"] = "complete",
      origin: Turn["origin"] = role === "assistant" ? "assistant" : "system",
    ) {
      return repos.turns.create({
        threadId: thread.id,
        role,
        origin,
        status,
        metadata,
        prevTurnId: (await repos.turns.getLatestByThread(thread.id))?.id,
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
    ) {
      const toolCallId = crypto.randomUUID();
      const call = await block(t, "tool_use", { toolCallId, toolName: name, input });
      const result = await block(t, "tool_result", {
        toolCallId,
        toolName: name,
        output,
        isError,
        metadata: {
          documentRevisions: [
            { documentId: "doc", uri: "manuscript://chapter.md", revision: "v1" },
          ],
        },
      });
      return { call, result };
    }
    return { repos, thread, bake, read, turn, block, tool, registry };
  }
  function output(result: Awaited<ReturnType<typeof readThreadHistory>>): string {
    expect(result).toHaveProperty("output");
    if (!("output" in result)) throw new Error("History read failed");
    return result.output;
  }
  function cursor(text: string) {
    return text.match(/next_cursor: (\S+)/)?.[1];
  }

  describe("thread_history", () => {
    it("batches pairs across page boundaries and scopes reused call ids to their turn", async () => {
      const f = await fixture();
      const first = await f.turn();
      for (let index = 0; index < 199; index++)
        await f.block(first, "reasoning", { text: "hidden" });
      await f.block(first, "tool_use", {
        toolCallId: "reused",
        toolName: "write",
        input: { command: "read", path: "manuscript://first.md" },
      });
      await f.block(first, "tool_result", { toolCallId: "reused", output: "FIRST SECRET" });
      const second = await f.turn();
      await f.block(second, "tool_use", {
        toolCallId: "reused",
        toolName: "write",
        input: { command: "read", path: "manuscript://second.md" },
      });
      await f.block(second, "tool_result", { toolCallId: "reused", output: "SECOND SECRET" });
      const batches = vi.spyOn(f.repos.blocks, "listToolBlocks");
      const text = output(await f.read({ order: "oldest_first", include: ["tool_results"] }));
      expect(text).toContain("manuscript://first.md");
      expect(text).toContain("manuscript://second.md");
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

    it("labels writer, steer, agent request, spawn prompt, assistant, thinking, completion, seed, complete/refused undo and failed C", async () => {
      const f = await fixture();
      const cases: [Turn["role"], Turn["origin"], JsonObject | null, string][] = [
        ["user", "writer", null, "writer"],
        ["user", "writer", { delivery: "steer" }, "writer, steer"],
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
        [
          "system",
          "system",
          { kind: "compaction_undo", revertsCompactionTurnId: "c" },
          "system: undo_marker",
        ],
      ];
      for (const [role, origin, metadata, label] of cases) {
        const t = await f.turn(role, metadata, "complete", origin);
        await f.block(t, "text", `text-${label}`);
      }
      await f.turn(
        "system",
        { kind: "compaction_undo", revertsCompactionTurnId: "c", reason: "would_recompact" },
        "error",
      );
      await f.turn(
        "compaction",
        { kind: "compaction", failure: { reason: "provider_error", phase: "summary" } },
        "error",
      );
      const response = await f.turn();
      await f.block(response, "reasoning", { text: "thinking-secret" });
      const defaults = output(await f.read({ order: "oldest_first" }));
      expect(defaults).toContain("writer");
      expect(defaults).toContain("agent");
      expect(defaults).not.toContain("thinking-secret");
      expect(defaults).not.toContain("system: undo_marker");
      const all = output(
        await f.read({ order: "oldest_first", include: ["system_messages", "thinking"] }),
      );
      for (const [, , , label] of cases) expect(all).toContain(label);
      expect(all).toContain("thinking-secret");
      expect(all).toContain("system: compaction");
    });
    it("segment headers identify Agent and bake, system_prompt appears once on each segment page", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.block(t, "text", "before");
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
        prevTurnId: t.id,
        compactionModel: "mock",
        metadata: {
          kind: "compaction",
          compactedThrough: { turnId: t.id },
          pinnedRequestTurnIds: [],
        },
      });
      await f.block(c, "custom", { kind: "compaction", props: { summary: "summary" } });
      const later = await f.turn();
      await f.block(later, "text", "after");
      const one = output(await f.read({ order: "oldest_first", include: ["system_prompt"] }));
      expect(one).toContain("Agent:");
      expect(one).toContain("initial-");
      expect(one.match(/INITIAL PROMPT/g)).toHaveLength(1);
      expect(one).not.toContain("after");
      const two = output(
        await f.read({
          order: "oldest_first",
          include: ["system_prompt", "system_messages"],
          cursor: cursor(one),
        }),
      );
      expect(two).toContain("compaction");
      expect(two).toContain("new-hash");
      expect(two.match(/NEW PROMPT/g)).toHaveLength(1);
      expect(two).toContain("summary");
    });
    it("100 hidden tool results do not burn the visible item limit", async () => {
      const f = await fixture();
      const t = await f.turn();
      for (let i = 0; i < 100; i++) await f.tool(t, "ls", {}, `hidden-${i}`);
      const first = output(await f.read({ order: "oldest_first" }));
      expect(first.match(/tool_call ls/g)).toHaveLength(40);
      expect(first).not.toContain("hidden-");
      const second = output(await f.read({ order: "oldest_first", cursor: cursor(first) }));
      expect(second.match(/tool_call ls/g)).toHaveLength(40);
    });
    it.each([
      "oldest_first",
      "newest_first",
    ])("CJK token-cap resumes without gaps in %s", async (order) => {
      const f = await fixture();
      const t = await f.turn();
      for (let i = 0; i < 20; i++) await f.block(t, "text", `${i}: ${"龍".repeat(600)}`);
      const seen: string[] = [];
      let next: string | undefined;
      do {
        const text = output(await f.read({ order, cursor: next }));
        seen.push(...[...text.matchAll(/\[(\d+\.\d+)\] assistant/g)].map((m) => m[1]));
        next = cursor(text);
      } while (next);
      expect(seen).toHaveLength(20);
      expect(new Set(seen).size).toBe(20);
    });
    it.each([
      {},
      { include: ["tool_results"] },
      { include: ["tool_args", "tool_results", "system_messages"] },
    ])("stubs copies and only opts in to labelled edit inputs: %j", async (input) => {
      const f = await fixture();
      const t = await f.turn();
      const read = await f.tool(
        t,
        "write",
        { command: "read", path: "manuscript://chapter.md" },
        "COPY SENTINEL",
      );
      const search = await f.tool(t, "search", { pattern: "Dragon" }, [
        {
          uri: "manuscript://chapter.md",
          matches: [{ excerpt: "COPY SENTINEL", line: 1 }],
          matchCount: 1,
        },
      ]);
      const edit = await f.tool(
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
      const diff = await f.tool(t, "write", { command: "diff" }, "COPY SENTINEL");
      const writer = await f.turn("user", null, "complete", "writer");
      await f.block(writer, "text", {
        type: "reference",
        documentId: "11111111-1111-4111-8111-111111111111",
        uri: "manuscript://chapter.md",
        text: "@chapter",
        read: { result: "COPY SENTINEL", revision: "v1" },
      } as JsonObject);
      const result = await f.read(input);
      const text = output(result);
      expect(text).not.toContain("COPY SENTINEL");
      if (input.include?.includes("tool_args")) {
        expect(text).toContain("EDIT SENTINEL");
        expect(text).toContain("edit record from");
        expect(result).toMatchObject({
          metadata: { documentRevisions: [{ documentId: "doc", revision: null }] },
        });
      } else {
        expect(text).not.toContain("EDIT SENTINEL");
        expect(result).toMatchObject({ metadata: { documentRevisions: [] } });
      }
      for (const pair of [read, edit, search, diff]) {
        const expanded = output(await f.read({ expand: `${t.position}.${pair.result.sequence}` }));
        expect(expanded).not.toContain("COPY SENTINEL");
      }
      const expanded = output(await f.read({ expand: `${t.position}.${edit.call.sequence}` }));
      expect(expanded).toContain("EDIT SENTINEL");
      expect(expanded).toContain("edit record from");
    });
    it("isError write output is verbatim and quoted edits clear at compaction, empty evidence stays", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.tool(
        t,
        "write",
        { command: "replace", content: "rejected edit", path: "manuscript://chapter.md" },
        "Write did not land: ERROR SENTINEL",
        true,
      );
      expect(output(await f.read({ include: ["tool_results"] }))).toContain("ERROR SENTINEL");
      for (const include of [[], ["tool_args"]]) {
        const result = await f.read({ include });
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
        if (include.length)
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
      await f.block(t, "text", "visible after scan budget");
      const first = output(await f.read({ order: "oldest_first" }));
      expect(first).not.toContain("visible after scan budget");
      expect(cursor(first)).toBeDefined();
      const second = output(await f.read({ order: "oldest_first", cursor: cursor(first) }));
      expect(second).toContain("visible after scan budget");
    });
    it("prints system_prompt only when a cursor opens a segment", async () => {
      const f = await fixture();
      const t = await f.turn();
      await f.block(t, "text", "first");
      await f.block(t, "text", "second");
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
      expect(first).toContain("INITIAL PROMPT");
      expect(next).not.toContain("INITIAL PROMPT");
      expect(next).toContain("Agent:");
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
    it("returns structured cursor/item errors", async () => {
      const f = await fixture();
      expect(await f.read({ cursor: "bad" })).toMatchObject({
        ok: false,
        error: { code: "invalid_cursor" },
      });
      expect(await f.read({ expand: "999.0" })).toMatchObject({
        ok: false,
        error: { code: "item_not_found" },
      });
    });
  });
}
