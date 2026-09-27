/** Domain operations for explicit agent handoff/fork into a new primary thread. */
import type { AgentSelection } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type {
  AgentRevisionBinding,
  AgentRevisionStore,
  BoundAgentCatalog,
} from "../../packages/index.js";
import { AgentSelectionError } from "../../packages/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkContextNotices,
  type WorkRepository,
} from "../../projects/index.js";
import type { EventJournalReader, EventJournalWriter } from "../ports/event-journal.js";
import type { InternalThreadRepositories } from "../ports/repositories.js";
import { createBoundConversation } from "./bound-conversation.js";
import { loadThreadConversationContext } from "./thread-conversation-context.js";

export interface ThreadAgentSwapDeps {
  threads: InternalThreadRepositories["threads"];
  threadWorks: InternalThreadRepositories["threadWorks"];
  turns: InternalThreadRepositories["turns"];
  blocks: InternalThreadRepositories["blocks"];
  threadDocuments: InternalThreadRepositories["threadDocuments"];
  transaction: InternalThreadRepositories["transaction"];
  projects: Pick<ProjectRepository, "findById">;
  works: Pick<WorkRepository, "findNoWork">;
  workContextNotices: Pick<WorkContextNotices, "threadChanged">;
  agentCatalog: BoundAgentCatalog;
  agentRevisions: AgentRevisionStore;
  eventReader: Pick<EventJournalReader, "listByType">;
  eventWriter: EventJournalWriter;
}

export class SubagentDerivationError extends Error {
  constructor(
    readonly threadId: string,
    readonly derivation: "fork" | "handoff",
  ) {
    super(`A subagent thread cannot be ${derivation}ed`);
    this.name = "SubagentDerivationError";
  }
}

export class ForkThreadConflictError extends Error {
  constructor() {
    super("The requested fork ID is already in use");
    this.name = "ForkThreadConflictError";
  }
}

export type ForkCutoffErrorCode = "turn_not_in_transcript" | "no_complete_turn";

export class ForkCutoffError extends Error {
  constructor(
    readonly code: ForkCutoffErrorCode,
    readonly turnId: string | null,
  ) {
    super(
      code === "turn_not_in_transcript"
        ? `Fork cutoff turn ${turnId} is not in the source's effective transcript`
        : "The source has no complete turn at or before the requested cutoff",
    );
    this.name = "ForkCutoffError";
  }
}

export async function handoffThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: {
    threadId: string;
    userId: string;
    agentSelection: AgentSelection;
    summary?: string | null;
  },
): Promise<Thread> {
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  if (source.kind === "subagent") throw new SubagentDerivationError(source.id, "handoff");
  const sourceWorkId = await requirePrimaryWorkId(deps, source.id, source.projectId);
  const binding = await resolveDerivedBinding(deps, source, input.userId, input.agentSelection);
  const summary = input.summary?.trim() || (await programmaticSummary(deps, source.id));
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    const lockedSource = await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    if (!lockedSource || lockedSource.deletedAt) throw new Error("Source thread no longer exists");
    const target = await createDerivedPrimaryWithMembership(
      deps,
      {
        userId: source.userId,
        projectId: source.projectId,
        workId: sourceWorkId,
        source: lockedSource,
        inheritedPrompt:
          (binding.revision?.id ?? null) === lockedSource.agentDefinitionRevisionId
            ? lockedSource
            : undefined,
        originType: "handoff",
        originTurnId: (await latestTurnId(deps, source.id)) as TurnId | null,
        title: `Handoff from ${source.title ?? "thread"}`,
      },
      sourceWorkId,
      binding,
    );
    await inheritEditingDocuments(deps, source, target);
    await seedSystemTurn(deps, target, `Handoff brief\n\n${summary}`);
    await deps.eventWriter.appendEvent(source.id as ThreadId, {
      type: "agent.handoff",
      sourceThreadId: source.id,
      targetThreadId: target.id,
      targetAgentSlug: binding.revision?.slug ?? null,
      summary,
    });
    return target;
  });
}

export async function forkThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: {
    id: string;
    threadId: string;
    userId: string;
    originTurnId?: string | null;
  },
): Promise<{ thread: Thread; created: boolean }> {
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  if (source.kind === "subagent") throw new SubagentDerivationError(source.id, "fork");
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    const lockedSource = await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    if (!lockedSource || lockedSource.deletedAt) throw new Error("Source thread no longer exists");

    const existing = await findIdempotentFork(deps, lockedSource, input);
    if (existing) return { thread: existing, created: false };

    const cutoff = await normalizeForkCutoff(deps, lockedSource, input.originTurnId);
    if (!(await deps.threads.findByIdIncludingDeleted(cutoff.turn.threadId as ThreadId))) {
      throw new ForkCutoffError("turn_not_in_transcript", cutoff.turn.id);
    }
    const sourceWorkId = await requirePrimaryWorkId(deps, lockedSource.id, lockedSource.projectId);
    const binding = await resolveRetainedForkBinding(deps, lockedSource);
    const result = await deps.threads.createDerivedPrimaryIfAbsent({
      id: input.id as ThreadId,
      userId: lockedSource.userId,
      projectId: lockedSource.projectId,
      workId: sourceWorkId,
      source: lockedSource,
      originType: "fork",
      originTurnId: cutoff.turn.id as TurnId,
      title: `Fork from ${lockedSource.title ?? "thread"}`,
      inheritedPrompt:
        (binding.revision?.id ?? null) === lockedSource.agentDefinitionRevisionId
          ? lockedSource
          : undefined,
    });
    if (!result.created) {
      const raced = await findIdempotentFork(deps, lockedSource, input);
      if (raced) return { thread: raced, created: false };
      throw new ForkThreadConflictError();
    }
    const target = await bindDerivedPrimaryWithMembership(
      deps,
      async () => result.thread,
      sourceWorkId,
      binding,
    );
    await inheritEditingDocuments(deps, lockedSource, target);
    await seedSystemTurn(deps, target, `Forked conversation through turn ${cutoff.turn.id}.`);
    await deps.eventWriter.appendEvent(source.id as ThreadId, {
      type: "agent.fork",
      sourceThreadId: source.id,
      targetThreadId: target.id,
      targetAgentSlug: binding.revision?.slug ?? null,
      originTurnId: cutoff.turn.id,
      requestedOriginTurnId: input.originTurnId ?? null,
    });
    return { thread: target, created: true };
  });
}

/** Same-revision derivations retain configuration even if the catalog has moved on. */
async function resolveDerivedBinding(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  userId: string,
  selection?: AgentSelection,
): Promise<AgentRevisionBinding> {
  const retained = await deps.agentRevisions.readThreadBinding(source.id);
  if (!retained) throw new Error("Source thread has no Agent binding");
  if (!selection || selection.definitionRevisionId === retained.revision?.id) {
    if (!retained.revision || retained.revision.definition.metadata.mode === "subagent") {
      throw new AgentSelectionError(retained.revision?.id ?? "generic subagent");
    }
    return retained;
  }
  const selected = await deps.agentCatalog.resolvePrimary(userId, selection, source.projectId);
  if (!selected.ok) throw new AgentSelectionError(selection.definitionRevisionId);
  return {
    revision: selected.revision,
    configuration: selected.configuration,
    invocationOverlay: null,
  };
}

/** Forks keep the exact retained binding and cannot resolve a catalog selection. */
async function resolveRetainedForkBinding(
  deps: ThreadAgentSwapDeps,
  source: Thread,
): Promise<AgentRevisionBinding> {
  const retained = await deps.agentRevisions.readThreadBinding(source.id);
  if (!retained) throw new Error("Source thread has no Agent binding");
  if (!retained.revision || retained.revision.definition.metadata.mode === "subagent") {
    throw new AgentSelectionError(retained.revision?.id ?? "generic subagent");
  }
  return retained;
}

async function normalizeForkCutoff(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  requestedTurnId: string | null | undefined,
): Promise<{ turn: Awaited<ReturnType<typeof loadThreadConversationContext>>["turns"][number] }> {
  const context = await loadThreadConversationContext(
    { threads: deps.threads, turns: deps.turns, blocks: deps.blocks },
    source,
  );
  const selectedTurnId = requestedTurnId ?? context.turns.at(-1)?.id;
  const selectedIndex = context.turns.findIndex((turn) => turn.id === selectedTurnId);
  if (!selectedTurnId || selectedIndex < 0) {
    throw new ForkCutoffError("turn_not_in_transcript", selectedTurnId ?? null);
  }

  let completeTurn: (typeof context.turns)[number] | undefined;
  for (const turn of context.turns.slice(0, selectedIndex + 1)) {
    if (turn.status === "complete") completeTurn = turn;
  }
  if (!completeTurn) throw new ForkCutoffError("no_complete_turn", selectedTurnId);
  return { turn: completeTurn };
}

async function findIdempotentFork(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  input: { id: string; userId: string; originTurnId?: string | null },
): Promise<Thread | null> {
  const existing = await deps.threads.findByIdIncludingDeleted(input.id as ThreadId);
  if (!existing) return null;
  if (
    existing.userId !== input.userId ||
    existing.projectId !== source.projectId ||
    existing.originType !== "fork" ||
    existing.kind !== "primary"
  ) {
    throw new ForkThreadConflictError();
  }

  const events = await deps.eventReader.listByType(source.id as ThreadId, "agent.fork");
  const matchingEvent = events.find((entry) => {
    const event = entry.payload;
    return (
      event.type === "agent.fork" &&
      event.sourceThreadId === source.id &&
      event.targetThreadId === existing.id &&
      event.originTurnId === existing.originTurnId &&
      event.requestedOriginTurnId === (input.originTurnId ?? null)
    );
  });
  if (!matchingEvent) throw new ForkThreadConflictError();
  return existing;
}

async function createDerivedPrimaryWithMembership(
  deps: ThreadAgentSwapDeps,
  input: Parameters<InternalThreadRepositories["threads"]["createDerivedPrimary"]>[0],
  membershipWorkId: WorkId,
  binding: AgentRevisionBinding,
): Promise<Thread> {
  return bindDerivedPrimaryWithMembership(
    deps,
    () => deps.threads.createDerivedPrimary(input),
    membershipWorkId,
    binding,
  );
}

async function bindDerivedPrimaryWithMembership(
  deps: ThreadAgentSwapDeps,
  createThread: () => Promise<Thread>,
  membershipWorkId: WorkId,
  binding: AgentRevisionBinding,
): Promise<Thread> {
  const target = await createBoundConversation({
    transaction: deps.transaction,
    agentRevisions: deps.agentRevisions,
    ...binding,
    createThread,
    resolveWork: async (target) => {
      await deps.threadWorks.addMembership(target.id as ThreadId, membershipWorkId, true);
      return membershipWorkId;
    },
  });
  // The inherited bake may predate the current Work or the chosen fork point.
  if (target.bakedSkillSlugs !== null) await deps.workContextNotices.threadChanged(target.id);
  return target;
}

async function requirePrimaryWorkId(
  deps: Pick<ThreadAgentSwapDeps, "threadWorks" | "works">,
  threadId: string,
  projectId: string,
): Promise<WorkId> {
  const membership = await deps.threadWorks.findPrimary(threadId as ThreadId);
  if (membership) return membership.workId;
  const noWork = await deps.works.findNoWork(projectId);
  if (!noWork) throw new Error("No Work is missing for this project");
  return noWork.id;
}

async function requireOwnedSourceThread(
  deps: ThreadAgentSwapDeps,
  threadId: string,
  userId: string,
): Promise<Thread> {
  const thread = await deps.threads.findById(threadId as ThreadId);
  if (!thread) throw new Error(`Thread not found: ${threadId}`);
  await requireProjectOwner({ projects: deps.projects }, thread.projectId, userId);
  return thread;
}

async function latestTurnId(deps: ThreadAgentSwapDeps, threadId: string): Promise<string | null> {
  const turn = await deps.turns.getLatestByThread(threadId as ThreadId);
  return turn?.id ?? null;
}

async function inheritEditingDocuments(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  target: Thread,
): Promise<void> {
  const documents = await deps.threadDocuments.listByThread(source.id as ThreadId);
  await Promise.all(
    documents
      .filter((document) => document.relationship === "editing")
      .map((document) =>
        deps.threadDocuments.attach(target.id as ThreadId, document.documentId, "editing"),
      ),
  );
}

async function programmaticSummary(deps: ThreadAgentSwapDeps, threadId: string): Promise<string> {
  const turns = await deps.turns.listByThread(threadId as ThreadId);
  const snippets = [];
  for (const turn of turns.slice(-6)) {
    const blocks = await deps.blocks.listByTurn(turn.id);
    const text = blocks
      .map((block) => block.textContent)
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .join("\n")
      .trim();
    if (text) snippets.push(`${turn.role}: ${text.slice(0, 600)}`);
  }
  return snippets.join("\n\n") || "No prior conversation content was available.";
}

async function seedSystemTurn(deps: ThreadAgentSwapDeps, thread: Thread, text: string) {
  const turn = await deps.turns.create({
    threadId: thread.id as ThreadId,
    role: "system",
    origin: "system",
    status: "complete",
  });
  await deps.blocks.create({
    turnId: turn.id,
    blockType: "text",
    sequence: 0,
    textContent: text,
    content: { text },
    status: "complete",
  });
}
