/**
 * E-2: shown-link capture records only what the model was actually shown
 * (contract §7.2). A copy's private source read, a search match past the
 * passage cap, an unauthorized search hit and a `thread_history` item quoting
 * an earlier write never become evidence; the shown read, echo and returned
 * passages do.
 */
import type { WriteOutcome } from "@meridian/agent-edit/integration";
import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup";
import { describe, expect, it, vi } from "vitest";
import { createInMemoryUnifiedContextPortFactory } from "../../domains/context/index.js";
import {
  createInMemoryUnifiedContextStoreRegistry,
  getInMemoryProjectContextStore,
} from "../../domains/context/support/in-memory-unified-context-stores.js";
import {
  createInMemoryShownLinkStore,
  createToolRegistry,
  type ShownLinkStore,
  type ToolHandlerContext,
} from "../../domains/runtime/index.js";
import { readThreadHistory } from "../../domains/runtime/spawn/thread-history.js";
import { createInMemoryRepositories } from "../../domains/threads/adapters/in-memory/index.js";
import { createReadHandler, createWriteHandler } from "./document-tools.js";
import { createModelToolRegistrations } from "./index.js";
import { createSearchHandler } from "./listing-tools.js";
import type { ResolvedModelContextPort, ToolWiringDeps } from "./tool-context.js";

const PROJECT = crypto.randomUUID() as ProjectId;
const USER = crypto.randomUUID() as UserId;
const SOURCE = crypto.randomUUID();
const TARGET = crypto.randomUUID();
const HIDDEN = crypto.randomUUID();

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

function success(command: "read" | "insert", shownLinks: SpelledLinkFact[]): WriteOutcome {
  return {
    status: "success",
    phase: "committed",
    command,
    isError: false,
    revision: null,
    result: { command, status: "success", phase: "committed" } as never,
    ...(shownLinks.length > 0 ? { shownLinks } : {}),
  };
}

/** Five matching blocks in each document, one link each; three passages come back. */
const searchEntries = Array.from({ length: 5 }, (_, n) => [`h${n}|needle ${n}`, "x|gap"]).flat();
const searchLinks = searchEntries.map((_, index) => (index % 2 === 0 ? [fact(index / 2)] : []));

async function harness() {
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
      // A copy's source read asks for nodes; a plain read shows facts.
      read: async (_command: unknown, context: { includeNodes?: boolean }) =>
        context.includeNodes
          ? { ...success("read", [fact(90)]), nodes: [] }
          : success("read", [fact(91)]),
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
  const thread = await repos.threads.create({ projectId: PROJECT, userId: USER, title: "e2" });
  const port = createInMemoryUnifiedContextPortFactory({
    documentSync: documentSync as never,
    storeRegistry: registry,
  }).forWork({ workId: crypto.randomUUID(), workSlug: null } as never, PROJECT, USER, new Map(), {
    threadId: thread.id,
    draftWork: null,
  });
  call.context = { port, livePort: () => port, resolution: {} as never };
  const turn = await repos.turns.create({
    threadId: thread.id,
    role: "assistant",
    origin: "assistant",
    status: "complete",
    metadata: null,
  });
  const ctx = {
    threadId: thread.id,
    turnId: turn.id,
    agentSlug: null,
    signal: new AbortController().signal,
  } as ToolHandlerContext;
  return { deps, store, repos, thread, turn, ctx };
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function shownRefs(store: ShownLinkStore, threadId: string, documentId: string) {
  return (await store.forDocument(threadId, documentId)).map((link) => link.ref).sort();
}

describe("shown-link capture", () => {
  it.each<{
    name: string;
    act: (h: Harness) => Promise<unknown>;
    shown: Record<string, SpelledLinkFact[]>;
  }>([
    {
      name: "a read records what it rendered",
      act: ({ deps, ctx }) => createReadHandler(deps)({ path: "user://source.md" }, ctx),
      shown: { [SOURCE]: [fact(91)], [TARGET]: [] },
    },
    {
      name: "a copy's private source read is never recorded; the write's echo is",
      act: ({ deps, ctx }) =>
        createWriteHandler(deps)(
          {
            command: "insert",
            path: "user://target.md",
            at: "end",
            from: { path: "user://source.md" },
          },
          ctx,
        ),
      shown: { [SOURCE]: [], [TARGET]: [fact(92)] },
    },
    {
      name: "search records returned passages, not matches past the cap or unauthorized hits",
      act: ({ deps, ctx }) => createSearchHandler(deps)({ pattern: "needle" }, ctx),
      shown: {
        [SOURCE]: [fact(0), fact(1), fact(2)],
        [TARGET]: [fact(0), fact(1), fact(2)],
        [HIDDEN]: [],
      },
    },
    {
      name: "a thread_history item quoting an earlier write is never recorded",
      act: async ({ deps, repos, thread, turn }) => {
        const toolCallId = crypto.randomUUID();
        const input = { command: "insert", path: "user://target.md", content: "[a](b.md)" };
        await repos.blocks.create({
          turnId: turn.id as TurnId,
          blockType: "tool_use",
          sequence: 0,
          content: { toolCallId, toolName: "write", input },
        });
        await repos.blocks.create({
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
        const registry = createToolRegistry({ registrations: createModelToolRegistrations(deps) });
        const caller = await repos.threads.findById(thread.id as ThreadId);
        if (!caller) throw new Error("thread missing");
        const history = await readThreadHistory({
          repos,
          registry,
          caller,
          input: {},
          tokenizer: "anthropic",
        });
        expect(JSON.stringify(history)).toContain("target.md");
      },
      shown: { [TARGET]: [] },
    },
  ])("$name", async ({ act, shown }) => {
    const h = await harness();
    await act(h);
    for (const [documentId, links] of Object.entries(shown)) {
      expect(await shownRefs(h.store, h.thread.id, documentId)).toEqual(
        links.map((link) => link.ref).sort(),
      );
    }
  });
});
