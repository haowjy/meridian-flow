/** Domain operations for explicit agent handoff/fork into a new primary thread. */
import type { AgentSelection, ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import type { AgentRevision, AgentRevisionStore, BoundAgentCatalog } from "../../packages/index.js";
import { AgentSelectionError } from "../../packages/index.js";
import {
  type ProjectRepository,
  requireProjectOwner,
  type WorkRepository,
} from "../../projects/index.js";
import type { EventJournalWriter } from "../ports/event-journal.js";
import type { InternalThreadRepositories } from "../ports/repositories.js";
import { createBoundConversation } from "./bound-conversation.js";

export interface ThreadAgentSwapDeps {
  threads: InternalThreadRepositories["threads"];
  threadWorks: InternalThreadRepositories["threadWorks"];
  turns: InternalThreadRepositories["turns"];
  blocks: InternalThreadRepositories["blocks"];
  threadDocuments: InternalThreadRepositories["threadDocuments"];
  transaction: InternalThreadRepositories["transaction"];
  projects: ProjectRepository;
  works: Pick<WorkRepository, "findNoWork">;
  agentCatalog: BoundAgentCatalog;
  agentRevisions: AgentRevisionStore;
  eventWriter: EventJournalWriter;
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
  const sourceWorkId = await requirePrimaryWorkId(deps, source.id, source.projectId);
  const binding = await deps.agentCatalog.resolvePrimary(
    input.userId,
    input.agentSelection,
    source.projectId,
  );
  if (!binding.ok) throw new AgentSelectionError(input.agentSelection.definitionRevisionId);
  const summary = input.summary?.trim() || (await programmaticSummary(deps, source.id));
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    const target = await createDerivedPrimaryWithMembership(
      deps,
      {
        userId: source.userId,
        projectId: source.projectId,
        workId: sourceWorkId,
        parentThreadId: source.id as ThreadId,
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
      targetAgentSlug: binding.revision.slug,
      summary,
    });
    return target;
  });
}

export async function forkThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: {
    threadId: string;
    userId: string;
    agentSelection: AgentSelection;
    originTurnId?: string | null;
  },
): Promise<Thread> {
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  const sourceWorkId = await requirePrimaryWorkId(deps, source.id, source.projectId);
  const binding = await deps.agentCatalog.resolvePrimary(
    input.userId,
    input.agentSelection,
    source.projectId,
  );
  if (!binding.ok) throw new AgentSelectionError(input.agentSelection.definitionRevisionId);
  const originTurnId = input.originTurnId ?? (await latestTurnId(deps, source.id));
  if (!originTurnId) throw new Error("Cannot fork a thread without an origin turn");
  const originTurn = await deps.turns.findById(originTurnId as TurnId);
  if (!originTurn || originTurn.threadId !== source.id) {
    throw new Error("Fork origin turn must belong to the source thread");
  }
  return deps.transaction(async () => {
    // The source journal is mutated after the new thread acquires its Work membership.
    await deps.threads.lockByIdIncludingDeleted(source.id as ThreadId);
    const target = await createDerivedPrimaryWithMembership(
      deps,
      {
        userId: source.userId,
        projectId: source.projectId,
        workId: sourceWorkId,
        parentThreadId: source.id as ThreadId,
        originType: "fork",
        originTurnId: originTurnId as TurnId,
        title: `Fork from ${source.title ?? "thread"}`,
      },
      sourceWorkId,
      binding,
    );
    await inheritEditingDocuments(deps, source, target);
    await seedSystemTurn(deps, target, `Forked conversation through turn ${originTurnId}.`);
    await deps.eventWriter.appendEvent(source.id as ThreadId, {
      type: "agent.fork",
      sourceThreadId: source.id,
      targetThreadId: target.id,
      targetAgentSlug: binding.revision.slug,
      originTurnId,
    });
    return target;
  });
}

async function createDerivedPrimaryWithMembership(
  deps: ThreadAgentSwapDeps,
  input: Parameters<InternalThreadRepositories["threads"]["createDerivedPrimary"]>[0],
  membershipWorkId: WorkId,
  binding: { revision: AgentRevision; configuration: ResolvedAgentConfiguration },
): Promise<Thread> {
  return createBoundConversation({
    transaction: deps.transaction,
    agentRevisions: deps.agentRevisions,
    ...binding,
    createThread: () => deps.threads.createDerivedPrimary(input),
    resolveWork: async (target) => {
      await deps.threadWorks.addMembership(target.id as ThreadId, membershipWorkId, true);
      return membershipWorkId;
    },
  });
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
