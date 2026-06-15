/** Route-core helpers for explicit agent handoff/fork into a new primary thread. */
import type { Thread } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { PackageRepository } from "../domains/packages/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import type { EventJournalWriter, InternalThreadRepositories } from "../domains/threads/index.js";
import { AgentBindingNotFoundError } from "./thread-creation.js";

export interface ThreadAgentSwapDeps {
  threads: InternalThreadRepositories["threads"];
  turns: InternalThreadRepositories["turns"];
  blocks: InternalThreadRepositories["blocks"];
  threadDocuments: InternalThreadRepositories["threadDocuments"];
  projects: ProjectRepository;
  packageRepository: PackageRepository;
  eventWriter: EventJournalWriter;
}

export async function handoffThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: { threadId: string; userId: string; targetAgent: string | null; summary?: string | null },
): Promise<Thread> {
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  await requireAgent(deps, source, input.targetAgent);
  const summary = input.summary?.trim() || (await programmaticSummary(deps, source.id));
  const target = await deps.threads.createDerivedPrimary({
    userId: source.userId,
    projectId: source.projectId,
    workId: source.workId as string,
    parentThreadId: source.id as ThreadId,
    originType: "handoff",
    originTurnId: (await latestTurnId(deps, source.id)) as TurnId | null,
    currentAgent: input.targetAgent,
    title: `Handoff from ${source.title ?? "thread"}`,
  });
  await inheritEditingDocuments(deps, source, target);
  await seedSystemTurn(deps, target, `Handoff brief\n\n${summary}`);
  await deps.eventWriter.appendEvent(source.id as ThreadId, {
    type: "agent.handoff",
    sourceThreadId: source.id,
    targetThreadId: target.id,
    targetAgentSlug: input.targetAgent,
    summary,
  });
  return target;
}

export async function forkThreadAgent(
  deps: ThreadAgentSwapDeps,
  input: {
    threadId: string;
    userId: string;
    targetAgent: string | null;
    originTurnId?: string | null;
  },
): Promise<Thread> {
  const source = await requireOwnedSourceThread(deps, input.threadId, input.userId);
  await requireAgent(deps, source, input.targetAgent);
  const originTurnId = input.originTurnId ?? (await latestTurnId(deps, source.id));
  if (!originTurnId) throw new Error("Cannot fork a thread without an origin turn");
  const originTurn = await deps.turns.findById(originTurnId as TurnId);
  if (!originTurn || originTurn.threadId !== source.id) {
    throw new Error("Fork origin turn must belong to the source thread");
  }
  const target = await deps.threads.createDerivedPrimary({
    userId: source.userId,
    projectId: source.projectId,
    workId: source.workId as string,
    parentThreadId: source.id as ThreadId,
    originType: "fork",
    originTurnId: originTurnId as TurnId,
    currentAgent: input.targetAgent,
    title: `Fork from ${source.title ?? "thread"}`,
  });
  await inheritEditingDocuments(deps, source, target);
  await seedSystemTurn(deps, target, `Forked conversation through turn ${originTurnId}.`);
  await deps.eventWriter.appendEvent(source.id as ThreadId, {
    type: "agent.fork",
    sourceThreadId: source.id,
    targetThreadId: target.id,
    targetAgentSlug: input.targetAgent,
    originTurnId,
  });
  return target;
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

async function requireAgent(
  deps: ThreadAgentSwapDeps,
  source: Thread,
  targetAgent: string | null,
): Promise<void> {
  if (!targetAgent) return;
  const resolved = await deps.packageRepository.getAgentWithLinkedSkills(
    source.projectId,
    source.userId,
    targetAgent,
  );
  if (!resolved.agent) throw new AgentBindingNotFoundError(targetAgent);
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
