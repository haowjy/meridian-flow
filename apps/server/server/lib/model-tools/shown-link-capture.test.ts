/**
 * E-2: shown-link capture records only what the model was actually shown
 * (contract §7.2), through the real runtime loop, tool registrations and
 * executor. A copy's private source read, a search match past the passage
 * cap, an unauthorized search hit, a `thread_history` item quoting an earlier
 * write, and a read whose result never came back (cancelled or timed out)
 * never become evidence; the shown read, echo and returned passages do, in the
 * view their facts were spelled in.
 */
import type { WriteOutcome } from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup";
import { describe, expect, it, vi } from "vitest";
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
import { readThreadHistory } from "../../domains/runtime/spawn/thread-history.js";
import { createInMemoryRepositories } from "../../domains/threads/adapters/in-memory/index.js";
import { createModelToolRegistrations } from "./index.js";
import type { ResolvedModelContextPort, ToolWiringDeps } from "./tool-context.js";

const PROJECT = crypto.randomUUID() as ProjectId;
const USER = crypto.randomUUID() as UserId;
const SOURCE = crypto.randomUUID();
const TARGET = crypto.randomUUID();
const HIDDEN = crypto.randomUUID();
const DRAFT: LinkView = { kind: "draft", workId: crypto.randomUUID() };

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

/** A core outcome whose facts were spelled in `view`, which need not be the grant's. */
function success(
  command: "read" | "insert",
  shownLinks: SpelledLinkFact[],
  view: LinkView = { kind: "live" },
): WriteOutcome {
  return {
    status: "success",
    phase: "committed",
    command,
    isError: false,
    revision: null,
    result: { command, status: "success", phase: "committed" } as never,
    ...(shownLinks.length > 0 ? { shownLinks, shownView: view } : {}),
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
  return { release, pending, wait: () => (started(), released) };
}

async function harness(options: { read?: () => Promise<void>; readTimeoutMs?: number } = {}) {
  const store = createInMemoryShownLinkStore({
    threads: { findByIdIncludingDeleted: async () => null },
    turns: { findById: async () => null },
  });
  const documentSync = {
    ensureDocument: async () => {},
    readEffectiveHashlines: async () => ({
      ok: true,
      value: { content: searchEntries, revision: "r1", links: searchLinks },
    }),
    refreshDocumentProjection: async () => {},
    agentEdit: () => ({
      // A copy's source read asks for nodes; a plain read shows facts spelled
      // in a reply's pinned draft, not the live grant it was routed with.
      read: async (_command: unknown, context: { includeNodes?: boolean }) => {
        if (context.includeNodes) return { ...success("read", [fact(90)]), nodes: [] };
        await options.read?.();
        return success("read", [fact(91)], DRAFT);
      },
      write: async () => success("insert", [fact(92)]),
    }),
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
  const repos = createInMemoryRepositories();
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
  return { deps, store, repos, registrations };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Runs one model turn that makes `calls`, returning every tool result it persisted. */
async function runTurn(
  h: Harness,
  calls: GenerateResult[],
  control: { signal?: AbortSignal; pending?: Promise<void>; abort?: () => void } = {},
) {
  const toolRegistry = createToolRegistry({ registrations: h.registrations });
  const rig = await runtimeScenario({
    gateway: scriptedGateway({ results: [...calls, done] }),
    toolRegistry,
    toolExecutor: createToolExecutor(toolRegistry),
    shownLinks: h.store,
  });
  const run = await rig.orchestrator.prepare({
    threadId: rig.thread.id,
    userText: "Go.",
    ...(control.signal ? { signal: control.signal } : {}),
  });
  const executed = run.execute();
  if (control.pending) {
    await control.pending;
    control.abort?.();
  }
  await executed;
  const results = rig.journal
    .getEvents(rig.thread.id)
    .map((entry) => entry.event)
    .filter((event) => event.type === "tool.result");
  return { threadId: rig.thread.id, results };
}

async function shown(store: ShownLinkStore, threadId: string, documentId: string) {
  return (await store.forDocument(threadId, documentId))
    .map((link) => `${link.ref.slice(4, 12)}@${link.view}`)
    .sort();
}
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
        { signal: controller.signal, pending: paused.pending, abort: () => controller.abort() },
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
