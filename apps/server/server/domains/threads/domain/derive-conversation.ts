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
import type { HandoffBriefLauncher } from "../ports/handoff-brief-launcher.js";
import type { InternalThreadRepositories, ThreadImageInclusion } from "../ports/repositories.js";
import { createBoundConversation } from "./bound-conversation.js";
import { bakeAt, bakeInEffect } from "./prompt-epochs.js";
import { projectImageInclusionDecision } from "./read-model-projector.js";
import { loadThreadConversationContext } from "./thread-conversation-context.js";
import { derivationSeedMetadata, handoffSeedMetadata } from "./turn-metadata.js";

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

export class DerivedThreadConflictError extends Error {
  constructor() {
    super("The requested derivation ID is already in use");
    this.name = "DerivedThreadConflictError";
  }
}

export class DerivedSourceNotFoundError extends Error {
  constructor() {
    super("Source thread not found");
    this.name = "DerivedSourceNotFoundError";
  }
}

export class HandoffInProgressError extends Error {
  readonly code = "handoff_in_progress";

  constructor() {
    super("handoff_in_progress");
    this.name = "HandoffInProgressError";
  }
}

export type ForkCutoffErrorCode =
  | "turn_not_in_transcript"
  | "unsettled_history"
  | "turn_not_actionable";

export class ForkCutoffError extends Error {
  constructor(
    readonly code: ForkCutoffErrorCode,
    readonly turnId: string | null,
  ) {
    super(
      {
        turn_not_in_transcript: `Derivation cutoff turn ${turnId} is not in the source's effective transcript`,
        unsettled_history: `Derivation cutoff turn ${turnId} has unsettled history`,
        turn_not_actionable: `Derivation is not available at turn ${turnId}`,
      }[code],
    );
    this.name = "ForkCutoffError";
  }
}

export async function handoffThreadAgent(
  deps: ThreadAgentSwapDeps & { handoffBriefs: HandoffBriefLauncher },
  input: {
    id: string;
    threadId: string;
    userId: string;
    originTurnId: string;
    agentSelection: AgentSelection;
  },
): Promise<{ thread: Thread; created: boolean }> {
  const existing = await findExistingDerivationBeforeSourceLoad(deps, input, "handoff");
  if (existing) return { thread: existing, created: false };
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  if (source.kind === "subagent") throw new SubagentDerivationError(source.id, "handoff");
  const claim = await deps.handoffBriefs.hold(input.id as ThreadId);
  if (!claim) throw new HandoffInProgressError();
  try {
    const result = await deps.transaction(async () => {
      const lockedSource = await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
      if (!lockedSource || lockedSource.deletedAt) throw new DerivedSourceNotFoundError();
      const existing = await findIdempotentDerivation(
        deps,
        lockedSource.projectId,
        input,
        "handoff",
      );
      if (existing) return { thread: existing, created: false };
      const cutoff = await requireDerivationCutoff(
        deps,
        lockedSource,
        input.originTurnId,
        "handoff",
      );
      const owner = await deps.threads.findByIdIncludingDeleted(cutoff.turn.threadId);
      if (!owner) throw new DerivedSourceNotFoundError();
      const workId = await requirePrimaryWorkId(deps, lockedSource.id, lockedSource.projectId);
      const binding = await resolveDerivedBinding(
        deps,
        lockedSource,
        input.userId,
        input.agentSelection,
      );
      const sameRevision =
        (binding.revision?.id ?? null) === lockedSource.agentDefinitionRevisionId;
      const inheritedBake = sameRevision ? await bakeInEffect(deps, lockedSource) : null;
      const result = await deps.threads.createDerivedPrimary({
        id: input.id as ThreadId,
        userId: lockedSource.userId,
        projectId: lockedSource.projectId,
        workId,
        source: owner,
        initialPromptBakeId: inheritedBake?.id ?? null,
        originType: "handoff",
        originTurnId: cutoff.turn.id as TurnId,
        title: `Handoff from ${lockedSource.title ?? "thread"}`,
      });
      if (!result.created)
        return {
          thread: requireIdempotentDerivation(
            result.thread,
            lockedSource.projectId,
            input,
            "handoff",
          ),
          created: false,
        };
      const target = await bindDerivedPrimary(deps, result.thread, workId, binding);
      await inheritEditingDocuments(deps, lockedSource, target);
      const seedId = crypto.randomUUID();
      const seed = await deps.turns.create({
        id: seedId,
        threadId: target.id,
        role: "system",
        origin: "system",
        status: "pending",
        metadata: handoffSeedMetadata({
          sourceThreadId: owner.id,
          sourceRef: owner.ref ?? owner.id,
          sourceTitle: owner.title,
          cutoffTurnId: cutoff.turn.id,
        }),
      });
      await deps.eventWriter.appendEvent(target.id, { type: "turn.created", turn: seed });
      deps.handoffBriefs.launchAfterCommit({ threadId: target.id, seedTurnId: seed.id, claim });
      await deps.eventWriter.appendEvent(lockedSource.id, {
        type: "agent.handoff",
        sourceThreadId: owner.id,
        targetThreadId: target.id,
        targetAgentSlug: binding.revision?.slug ?? null,
        originTurnId: cutoff.turn.id,
      });
      return { thread: target, created: true };
    });
    if (!result.created) await claim.release();
    return result;
  } catch (error) {
    await claim.release();
    throw error;
  }
}

export async function forkThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: {
    id: string;
    threadId: string;
    userId: string;
    originTurnId: string;
  },
): Promise<{ thread: Thread; created: boolean }> {
  const existing = await findExistingDerivationBeforeSourceLoad(deps, input);
  if (existing) return { thread: existing, created: false };

  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  if (source.kind === "subagent") throw new SubagentDerivationError(source.id, "fork");
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    const lockedSource = await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    if (!lockedSource || lockedSource.deletedAt) throw new Error("Source thread no longer exists");

    const existing = await findIdempotentDerivation(deps, lockedSource.projectId, input);
    if (existing) return { thread: existing, created: false };

    const cutoff = await requireDerivationCutoff(deps, lockedSource, input.originTurnId, "fork");
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
        thread: requireIdempotentDerivation(result.thread, lockedSource.projectId, input),
        created: false,
      };
    }
    const target = await bindDerivedPrimary(deps, result.thread, sourceWorkId, binding);
    const inheritedBlockIds = new Set(cutoff.blocks.map((block) => block.id));
    const turnOrder = new Map(cutoff.turns.map((turn, index) => [turn.id, index]));
    const decisionsAtCutoff: ThreadImageInclusion[] = [];
    for (const decision of await deps.imageInclusions.listByThread(lockedSource.id as ThreadId)) {
      const rank = turnOrder.get(decision.decisionTurnId);
      if (!inheritedBlockIds.has(decision.blockId) || rank === undefined) continue;
      decisionsAtCutoff.push(decision);
    }
    decisionsAtCutoff.sort(
      (left, right) =>
        (turnOrder.get(left.decisionTurnId) ?? -1) - (turnOrder.get(right.decisionTurnId) ?? -1),
    );
    for (const decision of decisionsAtCutoff) {
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

async function requireDerivationCutoff(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  selectedTurnId: string,
  derivation: "fork" | "handoff",
): Promise<{
  turn: Awaited<ReturnType<typeof loadThreadConversationContext>>["turns"][number];
  turns: Awaited<ReturnType<typeof loadThreadConversationContext>>["turns"];
  blocks: Awaited<ReturnType<typeof loadThreadConversationContext>>["blocks"];
}> {
  const context = await loadThreadConversationContext(
    { threads: deps.threads, turns: deps.turns, blocks: deps.blocks },
    source,
  );
  const selectedIndex = context.turns.findIndex((turn) => turn.id === selectedTurnId);
  if (selectedIndex < 0) throw new ForkCutoffError("turn_not_in_transcript", selectedTurnId);
  const turns = context.turns.slice(0, selectedIndex + 1);
  if (
    turns.some(
      (turn) =>
        turn.status !== "complete" && turn.status !== "cancelled" && turn.status !== "error",
    )
  ) {
    throw new ForkCutoffError("unsettled_history", selectedTurnId);
  }
  const selected = turns[selectedIndex];
  const actionable =
    derivation === "fork"
      ? selected.role === "assistant" ||
        (selected.role === "compaction" && selected.status === "complete")
      : selected.role === "assistant" ||
        (selected.role === "user" &&
          selected.origin === "writer" &&
          selected.status === "complete");
  if (!actionable) throw new ForkCutoffError("turn_not_actionable", selectedTurnId);
  const inheritedTurnIds = new Set(turns.map((turn) => turn.id));
  return {
    turn: selected,
    turns,
    blocks: context.blocks.filter((block) => inheritedTurnIds.has(block.turnId)),
  };
}

async function findIdempotentDerivation(
  deps: ThreadAgentSwapDeps,
  projectId: string,
  input: { id: string; userId: string },
  kind: "fork" | "handoff" = "fork",
): Promise<Thread | null> {
  const candidate = await deps.threads.findByIdIncludingDeleted(input.id as ThreadId);
  if (!candidate) return null;
  return requireIdempotentDerivation(candidate, projectId, input, kind);
}

function requireIdempotentDerivation(
  existing: Thread,
  projectId: string,
  input: { userId: string },
  kind: "fork" | "handoff" = "fork",
): Thread {
  if (
    existing.userId !== input.userId ||
    existing.projectId !== projectId ||
    existing.originType !== kind ||
    existing.kind !== "primary"
  ) {
    throw new DerivedThreadConflictError();
  }
  return existing;
}

async function findExistingDerivationBeforeSourceLoad(
  deps: ThreadAgentSwapDeps,
  input: { id: string; threadId: string; userId: string },
  kind: "fork" | "handoff" = "fork",
): Promise<Thread | null> {
  const candidate = await deps.threads.findByIdIncludingDeleted(input.id as ThreadId);
  if (!candidate) return null;

  const source = await deps.threads.findByIdIncludingDeleted(input.threadId as ThreadId);
  if (!source) throw new DerivedThreadConflictError();
  const existing = requireIdempotentDerivation(candidate, source.projectId, input, kind);
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

async function seedSystemTurn(deps: ThreadAgentSwapDeps, thread: Thread, text: string) {
  const turn = await deps.turns.create({
    threadId: thread.id as ThreadId,
    role: "system",
    origin: "system",
    status: "complete",
    metadata: derivationSeedMetadata("fork"),
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
