/**
 * E-2: shown-link capture records only what the model was actually shown
 * (contract §7.2), through the real runtime loop, tool registrations,
 * executor and reference reader. A copy's private source read, a search match
 * past the passage cap, an unauthorized search hit, a `thread_history` item
 * quoting an earlier write, a read whose result never came back (cancelled or
 * timed out), a result whose persistence failed, and a reference read from a
 * preparation that failed, was cancelled or was retried never become
 * evidence; the shown read, echo, returned passages and accepted reference
 * reads do, in the view their facts were spelled in, under the turn that
 * shows them. No persisted result carries the evidence itself.
 */
import type { WriteOutcome } from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createInMemoryUnifiedContextPortFactory } from "../../domains/context/index.js";
import {
  createInMemoryUnifiedContextStoreRegistry,
  getInMemoryProjectContextStore,
} from "../../domains/context/support/in-memory-unified-context-stores.js";
import type { GenerateResult } from "../../domains/runtime/gateway/index.js";
import {
  createInMemoryShownLinkStore,
  createToolExecutor,
  createToolRegistry,
  type ShownLinkStore,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import { runtimeScenario } from "../../domains/runtime/loop/__tests__/runtime-harness.js";
import { scriptedGateway } from "../../domains/runtime/loop/__tests__/test-gateway.js";
import type { ReferenceReader } from "../../domains/runtime/loop/reference-context.js";
import { dispatchToolCall } from "../../domains/runtime/loop/tool-dispatch.js";
import { readThreadHistory } from "../../domains/runtime/spawn/thread-history.js";
import { createInMemoryRepositories } from "../../domains/threads/adapters/in-memory/index.js";
import { InMemoryTransactionOwner } from "../../shared/in-memory-transaction.js";
import { createModelToolRegistrations, createReferenceReader } from "./index.js";
import { showingOf } from "./shown-link-capture.js";
import type { ResolvedModelContextPort, ToolWiringDeps } from "./tool-context.js";

const PROJECT = crypto.randomUUID() as ProjectId;
const USER = crypto.randomUUID() as UserId;
const SOURCE = crypto.randomUUID();
const TARGET = crypto.randomUUID();
const HIDDEN = crypto.randomUUID();
const DRAFT: LinkView = { kind: "draft", workId: crypto.randomUUID() };
const TARGET_URI = "user://target.md";

const call: { context?: ResolvedModelContextPort } = {};

// The thread's Work, chain and file policy are not under test: every call
// resolves to one live context port and every grant is a live edit grant.
vi.mock("./tool-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-context.js")>();
  return {
    ...actual,
    resolveToolCall: async () => ({ context: call.context, principal: {}, execution: {} }),
    resolveContextPort: async () => call.context,
  };
});
vi.mock("./file-access.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./file-access.js")>();
  return {
    ...actual,
    documentGrant: async () => ({ destination: { kind: "live" } }),
  };
});

const fact = (n: number): SpelledLinkFact => ({
  ref: `doc:${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
  address: `user://target-${n}.md`,
});

/**
 * A core outcome whose facts were spelled in `view` from `holderUri`; either
 * may differ from the grant's and the address the handler resolved.
 */
function success(
  command: "read" | "insert",
  links: SpelledLinkFact[],
  view: LinkView = { kind: "live" },
  holderUri = "user://source.md",
): WriteOutcome {
  return {
    status: "success",
    phase: "committed",
    command,
    isError: false,
    revision: null,
    result: { command, status: "success", phase: "committed" } as never,
    ...(links.length > 0 ? { showing: { holderUri, view, links } } : {}),
  };
}

/** Five matching blocks in each document, one link each; three passages come back. */
const searchEntries = Array.from({ length: 5 }, (_, n) => [`h${n}|needle ${n}`, "x|gap"]).flat();
const searchLinks = searchEntries.map((_, index) => (index % 2 === 0 ? [fact(index / 2)] : []));

const usage = { inputTokens: 1, outputTokens: 1 };
const toolCall = (name: string, input: Record<string, unknown>): GenerateResult => ({
  content: [{ type: "tool_use", toolCallId: `call-${name}`, toolName: name, input }],
  toolCalls: [],
  finishReason: "tool_use",
  usage,
  model: "gpt-4.1-mini",
  provider: "openai",
});
const done: GenerateResult = {
  content: [{ type: "text", text: "Done." }],
  toolCalls: [],
  finishReason: "end_turn",
  usage,
  model: "gpt-4.1-mini",
  provider: "openai",
};

/** A plain read that waits for `release`; resolves `started` once it is pending. */
function pausedRead() {
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = () => {
    started();
    return released;
  };
  return { release, pending, wait };
}

async function harness(
  options: {
    read?: () => Promise<void>;
    readTimeoutMs?: number;
    /** The blocks every document's search read returns, with each block's facts. */
    search?: { entries: string[]; links: SpelledLinkFact[][] };
    write?: (context: { responseId?: string }) => Promise<WriteOutcome>;
  } = {},
) {
  const transactionOwner = new InMemoryTransactionOwner();
  const inner = createInMemoryShownLinkStore({
    transactionOwner,
    threads: { findByIdIncludingDeleted: async () => null },
    turns: { findById: async () => null },
  });
  // Which turn each showing was recorded under, by document.
  const recordedTurns: Array<{ documentId: string; turnId: string }> = [];
  const store: ShownLinkStore = {
    forDocument: inner.forDocument,
    async record(input) {
      await inner.record(input);
      recordedTurns.push({ documentId: input.documentId, turnId: input.turnId });
    },
  };
  // Each plain read shows a fact of its own, so a retried read is told apart.
  let plainReads = 0;
  const documentSync = {
    ensureDocument: async () => {},
    readEffectiveHashlines: async ({ documentId }: { documentId: string }) => ({
      ok: true,
      value: {
        content: options.search?.entries ?? searchEntries,
        revision: "r1",
        links: options.search?.links ?? searchLinks,
        holder: { uri: `user://${names[documentId]}.md`, view: { kind: "live" } },
      },
    }),
    refreshDocumentProjection: async () => {},
    agentEdit: () => ({
      // A copy's source read asks for nodes; a plain read shows facts spelled
      // in a reply's pinned draft, not the live grant it was routed with.
      read: async (_command: unknown, context: { includeNodes?: boolean }) => {
        if (context.includeNodes) return { ...success("read", [fact(90)]), nodes: [] };
        const n = plainReads++;
        await options.read?.();
        return success("read", [fact(91 + 10 * n)], DRAFT);
      },
      write: async (_command: unknown, context: { responseId?: string }) =>
        options.write
          ? options.write(context)
          : success("insert", [fact(92)], undefined, TARGET_URI),
    }),
  };
  const names: Record<string, string> = {
    [SOURCE]: "source",
    [TARGET]: "target",
    [HIDDEN]: "hidden",
  };
  const registry = createInMemoryUnifiedContextStoreRegistry();
  const userStore = getInMemoryProjectContextStore(registry, PROJECT, USER, "user");
  for (const [id, name] of [
    [SOURCE, "source"],
    [TARGET, "target"],
    [HIDDEN, "hidden"],
  ] as const) {
    await userStore.createDocument({
      id,
      folderId: null,
      name,
      extension: "md",
      markdown: "needle",
      filetype: "markdown",
    });
  }
  const repos = createInMemoryRepositories({ transactionOwner });
  const deps = {
    threads: repos.threads,
    documentSync,
    shownLinks: store,
    fileAccess: {
      // The hidden document's hit is filtered before the model sees it.
      listAccess: async (_principal: unknown, ids: readonly string[]) =>
        new Map(ids.filter((id) => id !== HIDDEN).map((id) => [id, { level: "edit" }])),
    },
  } as unknown as ToolWiringDeps;
  const port = createInMemoryUnifiedContextPortFactory({
    documentSync: documentSync as never,
    storeRegistry: registry,
  }).forWork({ workId: crypto.randomUUID(), workSlug: null } as never, PROJECT, USER, new Map(), {
    threadId: crypto.randomUUID(),
    draftWork: null,
  });
  call.context = { port, livePort: () => port, resolution: {} as never };
  const registrations = createModelToolRegistrations(deps).map(
    (registration): ToolRegistration =>
      registration.definition.type === "function" &&
      registration.definition.name === "read" &&
      options.readTimeoutMs !== undefined
        ? { ...registration, timeoutMs: options.readTimeoutMs }
        : registration,
  );
  return {
    deps,
    store,
    repos,
    registrations,
    transactionOwner,
    recordedTurns,
    referenceReader: createReferenceReader(deps),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

type Rig = Awaited<ReturnType<typeof runtimeScenario>>;

/** An `@` reference to one of the harness documents. */
const reference = (documentId: string, name: string) => ({
  type: "reference" as const,
  text: `@${name}`,
  documentId,
  uri: `user://${name}.md`,
});

/**
 * Runs one model turn that makes `calls`, returning every tool result it
 * persisted. `during` runs once `pending` resolves, while the run prepares or
 * executes.
 */
async function runTurn(
  h: Harness,
  calls: GenerateResult[],
  control: {
    signal?: AbortSignal;
    pending?: Promise<void>;
    during?: (rig: Rig) => Promise<void>;
    userBlocks?: UserMessageBlock[];
    referenceReader?: ReferenceReader;
    responseWrites?: Parameters<typeof runtimeScenario>[0]["responseWrites"];
  } = {},
) {
  const toolRegistry = createToolRegistry({ registrations: h.registrations });
  const gateway = scriptedGateway({ results: [...calls, done] });
  const rig = await runtimeScenario({
    gateway,
    toolRegistry,
    toolExecutor: createToolExecutor(toolRegistry),
    shownLinks: h.store,
    transactionOwner: h.transactionOwner,
    referenceReader: control.referenceReader ?? h.referenceReader,
    ...(control.responseWrites ? { responseWrites: control.responseWrites } : {}),
  });
  let turnId: string | undefined;
  const executed = (async () => {
    const run = await rig.orchestrator.prepare({
      threadId: rig.thread.id,
      userText: "Go.",
      ...(control.userBlocks ? { userBlocks: control.userBlocks } : {}),
      ...(control.signal ? { signal: control.signal } : {}),
    });
    turnId = run.executionTurnId;
    return run.execute();
  })().catch((error: unknown) => ({ status: "threw" as const, error }));
  if (control.pending) {
    await control.pending;
    await control.during?.(rig);
  }
  const outcome = await executed;
  const results = rig.journal
    .getEvents(rig.thread.id)
    .map((entry) => entry.event)
    .filter((event) => event.type === "tool.result");
  const blocks = await rig.repos.blocks.listByThread(rig.thread.id as ThreadId);
  const turns = await rig.repos.turns.listByThread(rig.thread.id as ThreadId);
  return {
    threadId: rig.thread.id,
    results,
    outcome,
    turnId,
    turns,
    requests: gateway.requests.length,
    referenceBlocks: blocks.filter(
      (block) => (block.content as { type?: string } | null)?.type === "reference",
    ),
  };
}

/** A reader whose read of `uri` fails, as a reference that can't be loaded does; `read` lists what it read. */
const failingAt = (h: Harness, uri: string) => {
  const reads: string[] = [];
  const read: ReferenceReader["read"] = async (occurrence, ctx) => {
    if (occurrence.uri === uri) throw new Error("reference read failed");
    reads.push(occurrence.uri);
    return h.referenceReader.read(occurrence, ctx);
  };
  return { read, reads };
};

async function shown(store: ShownLinkStore, threadId: string, documentId: string) {
  return (await store.forDocument(threadId, documentId))
    .map((link) => `${link.ref.slice(4, 12)}@${link.view}`)
    .sort();
}
/** Host-only evidence: refs, and the fields that carry them beside a result. */
const HOST_FACTS = /doc:|ahead:|"showing"|"shown"/;
const expected = (links: SpelledLinkFact[], view = "live") =>
  links.map((link) => `${link.ref.slice(4, 12)}@${view}`).sort();

const rows: Array<{
  name: string;
  act(check: (actual: unknown, what: string) => ReturnType<typeof expect.soft>): Promise<{
    store: ShownLinkStore;
    threadId: string;
    shown: Record<string, string[]>;
  }>;
}> = [
  {
    name: "a read records what it rendered, in the view it was spelled in",
    async act() {
      const h = await harness();
      const { threadId } = await runTurn(h, [toolCall("read", { path: "user://source.md" })]);
      return {
        store: h.store,
        threadId,
        shown: { [SOURCE]: expected([fact(91)], `draft:${DRAFT.workId}`), [TARGET]: [] },
      };
    },
  },
  {
    name: "a copy's private source read is never recorded; the write's echo is",
    async act(check) {
      const h = await harness();
      const { threadId, results } = await runTurn(h, [
        toolCall("write", {
          command: "insert",
          path: "user://target.md",
          after: "h0",
          from: { path: "user://source.md" },
        }),
      ]);
      check(results, "the write succeeded").toEqual([
        expect.objectContaining({ isError: undefined }),
      ]);
      check(JSON.stringify(results), "the echo's result carries no host facts").not.toMatch(
        HOST_FACTS,
      );
      return {
        store: h.store,
        threadId,
        shown: { [SOURCE]: [], [TARGET]: expected([fact(92)]) },
      };
    },
  },
  {
    name: "search records returned passages, not matches past the cap or unauthorized hits",
    async act(check) {
      const h = await harness();
      const { threadId, results } = await runTurn(h, [toolCall("search", { pattern: "needle" })]);
      check(JSON.stringify(results), "search output carries no host facts").not.toContain("doc:");
      const passages = expected([fact(0), fact(1), fact(2)]);
      return {
        store: h.store,
        threadId,
        shown: { [SOURCE]: passages, [TARGET]: passages, [HIDDEN]: [] },
      };
    },
  },
  {
    name: "a search window records neither a link it left out nor one it cut through; verbose shows both",
    async act(check) {
      // The window keeps about 120 characters either side of the match.
      const filler = "filler ".repeat(100);
      const search = {
        entries: [
          `h0|needle ${filler}[Secret](user://never-shown.md)`,
          `h1|${"word ".repeat(22)}needle ${"word ".repeat(22)}[Cut through here](user://cut.md) ${filler}`,
        ],
        links: [[fact(80)], [fact(81)]],
      };
      const windowed = await harness({ search });
      const plain = await runTurn(windowed, [toolCall("search", { pattern: "needle" })]);
      // What the model reads: the rendered text, not the typed hits beside it.
      const output = plain.results
        .map((result) => String((result as { output?: unknown }).output))
        .join("\n");
      check(output, "the left-out link is not in the output").not.toContain("never-shown.md");
      check(output, "the window cuts into the second link").toContain("[Cut…");
      check(output, "its destination is cut off").not.toContain("user://cut.md)");
      check(await shown(windowed.store, plain.threadId, SOURCE), "windowed").toEqual([]);
      const whole = await harness({ search });
      const verbose = await runTurn(whole, [
        toolCall("search", { pattern: "needle", verbose: true }),
      ]);
      return {
        store: whole.store,
        threadId: verbose.threadId,
        shown: { [SOURCE]: expected([fact(80), fact(81)]) },
      };
    },
  },
  {
    name: "a staged echo and its settled receipt each keep the holder their own render spelled from",
    async act(check) {
      const MOVED = "user://moved/target.md";
      const h = await harness({
        write: async (context) => ({
          ...success("insert", [fact(94)], undefined, TARGET_URI),
          phase: "staged",
          ...(context.responseId ? { writeId: "w1", settlementId: "s1" } : {}),
        }),
      });
      const receipt = {
        ...success("insert", [fact(95)], undefined, MOVED),
        writeId: "w1",
        settlementId: "s1",
      };
      const { threadId, results } = await runTurn(
        h,
        [toolCall("write", { command: "insert", path: TARGET_URI, content: "x" })],
        {
          // The holder moved between the echo and the save: the receipt spells from its new folder.
          responseWrites: {
            async commitResponse(_id, _ctx, beforeCommit) {
              const settled = {
                status: "committed" as const,
                receipts: [{ documentId: TARGET, receipt: receipt as never }],
                concurrentEdits: [],
                refused: [],
              };
              await beforeCommit(settled);
              return settled;
            },
            async rollbackResponse() {},
          },
        },
      );
      check(results, "the staged echo, then the settled receipt").toEqual([
        expect.not.objectContaining({ isError: true }),
        expect.not.objectContaining({ isError: true }),
      ]);
      check(JSON.stringify(results), "echo and receipt results carry no host facts").not.toMatch(
        HOST_FACTS,
      );
      const bases = (await h.store.forDocument(threadId, TARGET))
        .map((link) => `${link.ref.slice(4, 12)}@${link.holderUri}`)
        .sort();
      check(bases, "each showing's base").toEqual(
        [
          `${fact(94).ref.slice(4, 12)}@${TARGET_URI}`,
          `${fact(95).ref.slice(4, 12)}@${MOVED}`,
        ].sort(),
      );
      return {
        store: h.store,
        threadId,
        shown: { [TARGET]: expected([fact(94), fact(95)]) },
      };
    },
  },
  {
    name: "the executor keeps a handler's host-only fields out of the persisted result",
    async act(check) {
      const h = await harness();
      const outcome = success("insert", [fact(96)], undefined, TARGET_URI);
      // A handler that hands back the whole routed outcome, not the structured shape.
      const registry = createToolRegistry({
        registrations: [
          {
            source: "core",
            definition: { type: "function", name: "write", description: "", inputSchema: {} },
            input: z.object({}),
            execution: {
              type: "server",
              handler: async () => ({ ...outcome, shown: showingOf(TARGET, outcome) }),
            },
          },
        ],
      });
      const executed = await createToolExecutor(registry).executeTool(
        { id: "call-write", name: "write", arguments: {} },
        { threadId: "thread" as ThreadId, turnId: "turn" as TurnId, agentSlug: null },
      );
      check(JSON.stringify(executed.result), "persisted result").not.toMatch(HOST_FACTS);
      check(executed.shown, "evidence still travels beside it").toHaveLength(1);
      return { store: h.store, threadId: "thread", shown: {} };
    },
  },
  {
    name: "a thread_history item quoting an earlier write is never recorded",
    async act(check) {
      const h = await harness();
      const thread = await h.repos.threads.create({ projectId: PROJECT, userId: USER });
      const turn = await h.repos.turns.create({
        threadId: thread.id,
        role: "assistant",
        origin: "assistant",
        status: "complete",
        metadata: null,
      });
      const toolCallId = crypto.randomUUID();
      const input = { command: "insert", path: "user://target.md", content: "[a](b.md)" };
      await h.repos.blocks.create({
        turnId: turn.id as TurnId,
        blockType: "tool_use",
        sequence: 0,
        content: { toolCallId, toolName: "write", input },
      });
      await h.repos.blocks.create({
        turnId: turn.id as TurnId,
        blockType: "tool_result",
        sequence: 1,
        content: {
          toolCallId,
          toolName: "write",
          output: "status: success\n\n[a](user://target-1.md)",
          isError: false,
          metadata: {
            documentRevisions: [{ documentId: TARGET, uri: "user://target.md", revision: "r" }],
          },
        },
      });
      const caller = await h.repos.threads.findById(thread.id as ThreadId);
      if (!caller) throw new Error("thread missing");
      const history = await readThreadHistory({
        repos: h.repos,
        registry: createToolRegistry({ registrations: h.registrations }),
        caller,
        input: {},
        tokenizer: "anthropic",
      });
      check(JSON.stringify(history), "history quotes the write").toContain("target.md");
      return { store: h.store, threadId: thread.id, shown: { [TARGET]: [] } };
    },
  },
  {
    name: "a read cancelled before it returned is never recorded, even when it finishes later",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait });
      const controller = new AbortController();
      const { threadId, results } = await runTurn(
        h,
        [toolCall("read", { path: "user://source.md" })],
        {
          signal: controller.signal,
          pending: paused.pending,
          during: async () => controller.abort(),
        },
      );
      paused.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(results, "no read result was persisted").toEqual([]);
      return { store: h.store, threadId, shown: { [SOURCE]: [] } };
    },
  },
  {
    name: "a read that timed out is never recorded, even when it finishes later",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait, readTimeoutMs: 20 });
      const { threadId, results } = await runTurn(h, [
        toolCall("read", { path: "user://source.md" }),
      ]);
      paused.release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      check(
        results.map((result) => (result as { output?: unknown }).output),
        "the model got the timeout",
      ).toEqual([expect.stringContaining("timed out")]);
      return { store: h.store, threadId, shown: { [SOURCE]: [] } };
    },
  },
  {
    name: "a result whose persistence fails leaves no evidence",
    async act(check) {
      const h = await harness();
      const thread = await h.repos.threads.create({ projectId: PROJECT, userId: USER });
      const turn = await h.repos.turns.create({
        threadId: thread.id,
        role: "assistant",
        origin: "assistant",
        status: "streaming",
        metadata: null,
      });
      const dispatched = await dispatchToolCall(
        {
          toolExecutor: {
            executeTool: async (toolCall: { id: string }) => ({
              toolCallId: toolCall.id,
              output: "read",
              result: {},
              shown: [
                {
                  documentId: SOURCE,
                  holderUri: "user://source.md",
                  view: { kind: "live" },
                  links: [fact(93)],
                },
              ],
            }),
          },
          eventSink: { emit() {} },
          shownLinks: h.store,
          persistenceDeps: {
            repos: h.repos,
            eventWriter: {
              async appendEvent(_threadId: string, event: { type: string }) {
                if (event.type === "tool.result") throw new Error("journal append failed");
              },
            },
          },
        } as never,
        { id: "call-failed", name: "read", arguments: {} },
        {
          thread,
          responseId: crypto.randomUUID(),
          state: { threadId: thread.id, currentTurn: turn, allBlocks: [] },
          lease: {},
          interruptSession: {},
          interruptAutoResume: {},
          treeBudget: {},
          blockSeqRef: { value: 0 },
          allTurns: [],
        } as never,
      ).catch((error: Error) => error.message);
      check(dispatched, "dispatch failed").toBe("journal append failed");
      check(await h.repos.blocks.listByThread(thread.id), "no result persisted").toEqual([]);
      return { store: h.store, threadId: thread.id, shown: { [SOURCE]: [] } };
    },
  },
  {
    name: "an accepted reference read records under the turn whose request shows it",
    async act(check) {
      const h = await harness();
      const run = await runTurn(h, [], {
        userBlocks: [{ type: "text", text: "Go " }, reference(SOURCE, "source")],
      });
      check(run.outcome.status, "the run completed").toBe("complete");
      check(h.recordedTurns, "recorded under the run's turn").toEqual([
        { documentId: SOURCE, turnId: run.turnId },
      ]);
      check(JSON.stringify(run.referenceBlocks), "the read is saved").toContain("success");
      check(JSON.stringify(run.referenceBlocks), "no host facts in the block").not.toContain(
        "doc:",
      );
      return {
        store: h.store,
        threadId: run.threadId,
        shown: { [SOURCE]: expected([fact(91)], `draft:${DRAFT.workId}`) },
      };
    },
  },
  {
    name: "a later reference failing keeps the earlier reference's read from becoming evidence",
    async act(check) {
      const h = await harness();
      const reader = failingAt(h, "user://target.md");
      const run = await runTurn(h, [], {
        userBlocks: [reference(SOURCE, "source"), reference(TARGET, "target")],
        referenceReader: reader,
      });
      check(reader.reads, "the first reference was read").toEqual(["user://source.md"]);
      check(run.outcome.status, "the run failed").toBe("error");
      check(run.requests, "the model was never asked").toBe(0);
      check(JSON.stringify(run.referenceBlocks), "no read saved").not.toContain("success");
      return { store: h.store, threadId: run.threadId, shown: { [SOURCE]: [], [TARGET]: [] } };
    },
  },
  {
    name: "a reference read cancelled during preparation is never recorded, even when it finishes",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait });
      const controller = new AbortController();
      const run = await runTurn(h, [], {
        userBlocks: [reference(SOURCE, "source")],
        signal: controller.signal,
        pending: paused.pending,
        during: async () => {
          controller.abort();
          paused.release();
        },
      });
      check(run.requests, "the model was never asked").toBe(0);
      return { store: h.store, threadId: run.threadId, shown: { [SOURCE]: [] } };
    },
  },
  {
    name: "a preparation retried after its selection changed records only the attempt it commits",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait });
      let reads = 0;
      const run = await runTurn(h, [], {
        userBlocks: [reference(SOURCE, "source")],
        pending: paused.pending,
        // A message arriving during the first attempt's read retries it.
        referenceReader: {
          read: (occurrence, ctx) => {
            reads++;
            return h.referenceReader.read(occurrence, ctx);
          },
        },
        during: async (rig) => {
          await rig.send(rig.thread.id, "One more thing.");
          paused.release();
        },
      });
      // The retry answers the newer message, so the discarded read is all there was.
      check(run.outcome.status, "the run completed").toBe("complete");
      check(reads, "the first attempt read the reference").toBe(1);
      check(JSON.stringify(run.referenceBlocks), "its read was discarded").not.toContain("success");
      return { store: h.store, threadId: run.threadId, shown: { [SOURCE]: [] } };
    },
  },
  {
    name: "a reference adopted mid-run records under the successor turn that shows it",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait });
      const run = await runTurn(h, [toolCall("read", { path: "user://source.md" })], {
        pending: paused.pending,
        during: async (rig) => {
          await rig.send(rig.thread.id, "Also this", {
            blocks: [{ type: "text", text: "Also " }, reference(TARGET, "target")],
          });
          paused.release();
        },
      });
      check(run.outcome.status, "the run completed").toBe("complete");
      const successor = run.turns.filter((turn) => turn.role === "assistant").at(-1);
      check(
        h.recordedTurns.filter((row) => row.documentId === TARGET),
        "recorded under the successor",
      ).toEqual([{ documentId: TARGET, turnId: successor?.id }]);
      check(successor?.id, "a successor was reserved").not.toBe(run.turnId);
      return {
        store: h.store,
        threadId: run.threadId,
        shown: { [TARGET]: expected([fact(101)], `draft:${DRAFT.workId}`) },
      };
    },
  },
  {
    name: "a mid-run adoption whose reference fails records none of its reads",
    async act(check) {
      const paused = pausedRead();
      const h = await harness({ read: paused.wait });
      const reader = failingAt(h, "user://hidden.md");
      const run = await runTurn(h, [toolCall("read", { path: "user://source.md" })], {
        pending: paused.pending,
        referenceReader: reader,
        during: async (rig) => {
          await rig.send(rig.thread.id, "Also these", {
            blocks: [reference(TARGET, "target"), reference(HIDDEN, "hidden")],
          });
          paused.release();
        },
      });
      check(reader.reads, "the first adopted reference was read").toEqual(["user://target.md"]);
      check(JSON.stringify(run.referenceBlocks), "no adopted read saved").not.toContain("success");
      return { store: h.store, threadId: run.threadId, shown: { [TARGET]: [] } };
    },
  },
];

describe("shown-link capture", () => {
  it("E-2: only results the model was shown become evidence", async () => {
    for (const row of rows) {
      const check = (actual: unknown, what: string) => expect.soft(actual, `${row.name}: ${what}`);
      try {
        const { store, threadId, shown: want } = await row.act(check);
        for (const [documentId, links] of Object.entries(want)) {
          check(await shown(store, threadId, documentId), `evidence for ${documentId}`).toEqual(
            links,
          );
        }
      } catch (error) {
        check(error, "row threw").toBeUndefined();
      }
    }
  });
});
