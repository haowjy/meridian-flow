/**
 * In-memory shown-link storage matches the runtime store contract.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current shown links persistence protocol (kb/decisions/engineering/runtime/runtime-delivery-and-run-claim.md)
 */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Thread, Turn } from "@meridian/contracts/threads";
import type { SpelledLinkFact } from "@meridian/markup/links";
import { describe, expect, it } from "vitest";
import { InMemoryTransactionOwner } from "../../shared/in-memory-transaction.js";
import { createInMemoryRepositories } from "../threads/adapters/in-memory/index.js";
import { createInMemoryShownLinkStore } from "./adapters/in-memory/shown-links.js";
import {
  type ShownLinksCheck,
  type ShownLinksRig,
  shownLinkStoreChecks,
} from "./shown-links.test-support.js";

async function rig(): Promise<ShownLinksRig> {
  const owner = new InMemoryTransactionOwner();
  const repos = createInMemoryRepositories({ transactionOwner: owner });
  const userId = crypto.randomUUID() as UserId;
  const projectId = crypto.randomUUID() as ProjectId;
  const documentId = crypto.randomUUID();
  const source = await repos.threads.create({ aiWriteMode: "direct", userId, projectId });
  const answer = await repos.turns.create({
    threadId: source.id as ThreadId,
    role: "assistant",
    origin: "assistant",
    status: "complete",
  });
  const child = await repos.threads.createSubagent({
    aiWriteMode: "direct",
    userId,
    projectId,
    parentThreadId: source.id as ThreadId,
    rootThreadId: source.id as ThreadId,
    originTurnId: answer.id as TurnId,
    spawnDepth: 1,
  });
  const store = createInMemoryShownLinkStore({
    transactionOwner: owner,
    threads: repos.threads,
    turns: repos.turns,
  });
  const show = (threadId: string, turn: Turn, links: SpelledLinkFact[]) =>
    store.record({
      threadId,
      turnId: turn.id,
      documentId,
      holderUri: "kb://chapter.md",
      view: { kind: "live" },
      links,
    });
  return {
    childId: child.id,
    store,
    answer,
    source,
    documentId,
    show,
    async seen(threadId) {
      return (await store.forDocument(threadId, documentId))
        .map((row) => `${row.ref.slice(4, 12)}@${row.address}`)
        .sort();
    },
    async derive(originType, origin, from = source) {
      return (
        await repos.threads.createDerivedPrimary({
          aiWriteMode: "direct",
          id: crypto.randomUUID(),
          source: from,
          workId: from.workId,
          userId: from.userId,
          projectId: from.projectId,
          originType,
          originTurnId: origin.id as TurnId,
        })
      ).thread;
    },
    next(thread: Thread, prev: Turn) {
      return repos.turns.create({
        threadId: thread.id as ThreadId,
        prevTurnId: prev.id as TurnId,
        role: "user",
        origin: "writer",
        status: "complete",
      });
    },
    transaction: (operation) => owner.run(operation),
  };
}

describe("shown links (in memory)", () => {
  it("keeps evidence across dedup, lineage and rollback", async () => {
    for (const row of shownLinkStoreChecks) {
      const check: ShownLinksCheck = (actual, what) => expect.soft(actual, `${row.name}: ${what}`);
      try {
        await row.run(await rig(), check);
      } catch (error) {
        check(error, "row threw").toBeUndefined();
      }
    }
  });
});
