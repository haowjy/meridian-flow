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
import type { EventJournalWriter } from "../ports/event-journal.js";
import type { InternalThreadRepositories } from "../ports/repositories.js";
import { createBoundConversation } from "./bound-conversation.js";
import { bakeAt, bakeInEffect } from "./prompt-epochs.js";
import { projectImageInclusionDecision } from "./read-model-projector.js";
import { loadThreadConversationContext } from "./thread-conversation-context.js";

export interface ThreadAgentSwapDeps {
  threads: InternalThreadRepositories["threads"];
  threadWorks: InternalThreadRepositories["threadWorks"];
  turns: InternalThreadRepositories["turns"];
  promptBakes: InternalThreadRepositories["promptBakes"];
  blocks: InternalThreadRepositories["blocks"];
  imageInclusions: InternalThreadRepositories["imageInclusions"];
  threadDocuments: InternalThreadRepositories["threadDocuments"];
  transaction: InternalThreadRepositories["transaction"];
  projects: Pick<ProjectRepository, "findById">;
  works: Pick<WorkRepository, "findNoWork">;
  workContextNotices: Pick<WorkContextNotices, "threadChanged">;
  agentCatalog: BoundAgentCatalog;
  agentRevisions: AgentRevisionStore;
  eventWriter: EventJournalWriter;
}

export class SubagentDerivationError extends Error {
  constructor(
    readonly threadId: string,
    readonly derivation: "fork" | "handoff",
  ) {
    const verb = { fork: "forked", handoff: "handed off" }[derivation];
    super(`A subagent thread cannot be ${verb}`);
    this.name = "SubagentDerivationError";
  }
}

export class ForkThreadConflictError extends Error {
  constructor() {
    super("The requested fork ID is already in use");
    this.name = "ForkThreadConflictError";
  }
}

export class DerivedSourceNotFoundError extends Error {
  constructor() {
    super("Source thread not found");
    this.name = "DerivedSourceNotFoundError";
  }
}

export type ForkCutoffErrorCode = "turn_not_in_transcript" | "no_settled_turn";

export class ForkCutoffError extends Error {
  constructor(
    readonly code: ForkCutoffErrorCode,
    readonly turnId: string | null,
  ) {
    super(
      code === "turn_not_in_transcript"
        ? `Fork cutoff turn ${turnId} is not in the source's effective transcript`
        : "The source has no settled turn at or before the requested cutoff",
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
    const sameRevision = (binding.revision?.id ?? null) === lockedSource.agentDefinitionRevisionId;
    const inheritedBake = sameRevision ? await bakeInEffect(deps, lockedSource) : null;
    const result = await deps.threads.createDerivedPrimary({
      id: crypto.randomUUID() as ThreadId,
      userId: source.userId,
      projectId: source.projectId,
      workId: sourceWorkId,
      source: lockedSource,
      initialPromptBakeId: inheritedBake?.id ?? null,
      originType: "handoff",
      originTurnId: (await latestTurnId(deps, source.id)) as TurnId | null,
      title: `Handoff from ${source.title ?? "thread"}`,
    });
    if (!result.created) throw new Error("Failed to create handoff thread with a fresh ID");
    const target = await bindDerivedPrimary(deps, result.thread, sourceWorkId, binding);
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
  const existing = await findExistingForkBeforeSourceLoad(deps, input);
  if (existing) return { thread: existing, created: false };

  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  if (source.kind === "subagent") throw new SubagentDerivationError(source.id, "fork");
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    const lockedSource = await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    if (!lockedSource || lockedSource.deletedAt) throw new Error("Source thread no longer exists");

    const existing = await findIdempotentFork(deps, lockedSource.projectId, input);
    if (existing) return { thread: existing, created: false };

    const cutoff = await normalizeForkCutoff(deps, lockedSource, input.originTurnId);
    const inheritedBake = await bakeAt(deps, cutoff.turn);
    const sourceWorkId = await requirePrimaryWorkId(deps, lockedSource.id, lockedSource.projectId);
    const binding = await resolveDerivedBinding(deps, lockedSource, input.userId);
    const result = await deps.threads.createDerivedPrimary({
      id: input.id as ThreadId,
      userId: lockedSource.userId,
      projectId: lockedSource.projectId,
      workId: sourceWorkId,
      source: lockedSource,
      originType: "fork",
      originTurnId: cutoff.turn.id as TurnId,
      title: `Fork from ${lockedSource.title ?? "thread"}`,
      initialPromptBakeId: inheritedBake?.id ?? null,
    });
    if (!result.created) {
      return {
        thread: requireIdempotentFork(result.thread, lockedSource.projectId, input),
        created: false,
      };
    }
    const target = await bindDerivedPrimary(deps, result.thread, sourceWorkId, binding);
    const inheritedBlockIds = new Set(cutoff.blocks.map((block) => block.id));
    const inheritedTurnIds = new Set(cutoff.turns.map((turn) => turn.id));
    for (const decision of await deps.imageInclusions.findByThread(lockedSource.id as ThreadId)) {
      if (
        !inheritedBlockIds.has(decision.blockId) ||
        !inheritedTurnIds.has(decision.decisionTurnId)
      )
        continue;
      const event = {
        type: "image.inclusion_decided" as const,
        threadId: target.id,
        blockId: decision.blockId,
        decisionTurnId: decision.decisionTurnId,
        included: decision.included,
      };
      await projectImageInclusionDecision(deps, event);
      await deps.eventWriter.appendEvent(target.id as ThreadId, event);
    }
    await inheritEditingDocuments(deps, lockedSource, target);
    await seedSystemTurn(deps, target, `Forked conversation through turn ${cutoff.turn.id}.`);
    await deps.eventWriter.appendEvent(source.id as ThreadId, {
      type: "agent.fork",
      sourceThreadId: source.id,
      targetThreadId: target.id,
      targetAgentSlug: binding.revision?.slug ?? null,
      originTurnId: cutoff.turn.id,
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

async function normalizeForkCutoff(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  requestedTurnId: string | null | undefined,
): Promise<{
  turn: Awaited<ReturnType<typeof loadThreadConversationContext>>["turns"][number];
  turns: Awaited<ReturnType<typeof loadThreadConversationContext>>["turns"];
  blocks: Awaited<ReturnType<typeof loadThreadConversationContext>>["blocks"];
}> {
  const context = await loadThreadConversationContext(
    { threads: deps.threads, turns: deps.turns, blocks: deps.blocks },
    source,
  );
  const selectedTurnId = requestedTurnId ?? context.turns.at(-1)?.id;
  if (!selectedTurnId && requestedTurnId == null) {
    throw new ForkCutoffError("no_settled_turn", null);
  }
  const selectedIndex = context.turns.findIndex((turn) => turn.id === selectedTurnId);
  if (!selectedTurnId || selectedIndex < 0) {
    throw new ForkCutoffError("turn_not_in_transcript", selectedTurnId ?? null);
  }

  let settledTurn: (typeof context.turns)[number] | undefined;
  for (const turn of context.turns.slice(0, selectedIndex + 1)) {
    if (
      turn.status === "pending" ||
      turn.status === "streaming" ||
      turn.status === "waiting_interrupt"
    ) {
      break;
    }
    if (turn.status === "complete" || turn.status === "cancelled" || turn.status === "error") {
      settledTurn = turn;
    }
  }
  if (!settledTurn) throw new ForkCutoffError("no_settled_turn", selectedTurnId);
  const cutoffIndex = context.turns.findIndex((turn) => turn.id === settledTurn?.id);
  const inheritedTurnIds = new Set(context.turns.slice(0, cutoffIndex + 1).map((turn) => turn.id));
  return {
    turn: settledTurn,
    turns: context.turns.slice(0, cutoffIndex + 1),
    blocks: context.blocks.filter((block) => inheritedTurnIds.has(block.turnId)),
  };
}

async function findIdempotentFork(
  deps: ThreadAgentSwapDeps,
  projectId: string,
  input: { id: string; userId: string },
): Promise<Thread | null> {
  const candidate = await deps.threads.findByIdIncludingDeleted(input.id as ThreadId);
  if (!candidate) return null;
  return requireIdempotentFork(candidate, projectId, input);
}

function requireIdempotentFork(
  existing: Thread,
  projectId: string,
  input: { userId: string },
): Thread {
  if (
    existing.userId !== input.userId ||
    existing.projectId !== projectId ||
    existing.originType !== "fork" ||
    existing.kind !== "primary"
  ) {
    throw new ForkThreadConflictError();
  }
  return existing;
}

async function findExistingForkBeforeSourceLoad(
  deps: ThreadAgentSwapDeps,
  input: { id: string; threadId: string; userId: string },
): Promise<Thread | null> {
  const candidate = await deps.threads.findByIdIncludingDeleted(input.id as ThreadId);
  if (!candidate) return null;

  const source = await deps.threads.findByIdIncludingDeleted(input.threadId as ThreadId);
  if (!source) throw new ForkThreadConflictError();
  const existing = requireIdempotentFork(candidate, source.projectId, input);
  await requireProjectOwner({ projects: deps.projects }, source.projectId, input.userId);
  return existing;
}

async function bindDerivedPrimary(
  deps: ThreadAgentSwapDeps,
  thread: Thread,
  membershipWorkId: WorkId,
  binding: AgentRevisionBinding,
): Promise<Thread> {
  const target = await createBoundConversation({
    transaction: deps.transaction,
    agentRevisions: deps.agentRevisions,
    ...binding,
    createThread: async () => thread,
    resolveWork: async (target) => {
      await deps.threadWorks.addMembership(target.id as ThreadId, membershipWorkId, true);
      return membershipWorkId;
    },
  });
  // The inherited bake may predate the current Work or the chosen fork point.
  if (target.initialPromptBakeId != null) await deps.workContextNotices.threadChanged(target.id);
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
  if (!thread) throw new DerivedSourceNotFoundError();
  const project = await deps.projects.findById(thread.projectId);
  if (!project || project.userId !== userId || project.deletedAt) {
    throw new DerivedSourceNotFoundError();
  }
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
