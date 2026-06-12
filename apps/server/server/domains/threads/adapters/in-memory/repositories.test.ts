/**
 * In-memory thread adapter tests: runs shared repository/document/event-journal
 * conformance against the local in-memory implementations used by tests and dev.
 */
import { describe, expect, it } from "vitest";
import {
  createInMemoryWorkbenchRepository,
  createInMemoryWorkRepository,
} from "../../../workbenches/index.js";
import { describeEventJournalConformance } from "../__conformance__/event-journal.conformance.js";
import { describeThreadDocumentRepositoriesConformance } from "../__conformance__/thread-document-repositories.conformance.js";
import { describeThreadRepositoriesConformance } from "../__conformance__/thread-repositories.conformance.js";
import { createInMemoryEventJournalReader } from "./event-reader.js";
import { createInMemoryEventJournalWriter } from "./event-writer.js";
import { createInMemoryRepositories } from "./repositories.js";

function createFixture() {
  const workbenches = createInMemoryWorkbenchRepository();
  const works = createInMemoryWorkRepository();
  return {
    workbenches,
    works,
    repos: createInMemoryRepositories({ workbenches, works }),
  };
}

describeThreadRepositoriesConformance("in-memory", createFixture);
describeThreadDocumentRepositoriesConformance("in-memory", () => ({
  ...createFixture(),
  async createDocument(_workbenchId, _name) {
    return crypto.randomUUID();
  },
}));

describeEventJournalConformance("in-memory", async () => {
  const { repos, workbenches } = createFixture();
  const workbench = await workbenches.create({ userId: "user_1", title: "Workbench" });
  const thread = await repos.threads.create({ userId: "user_1", workbenchId: workbench.id });
  const journalWriter = createInMemoryEventJournalWriter();
  return {
    journalReader: createInMemoryEventJournalReader(journalWriter),
    journalWriter,
    async createTurn() {
      return repos.turns.create({ threadId: thread.id, role: "assistant" });
    },
  };
});

describe("in-memory event journal", () => {
  it("writes events and replays by thread, type, cursor, and time range", async () => {
    const { repos, workbenches } = createFixture();
    const workbench = await workbenches.create({ userId: "user_1", title: "Workbench" });
    const thread = await repos.threads.create({ userId: "user_1", workbenchId: workbench.id });
    const turn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
    const journal = createInMemoryEventJournalWriter();

    const firstSeq = await journal.appendEvent(thread.id, { type: "turn.created", turn });
    const secondSeq = await journal.appendEvent(thread.id, {
      type: "stream.delta",
      kind: "text",
      text: "hello",
    });
    await journal.appendEvent("other_thread", { type: "stream.delta", kind: "text", text: "x" });

    expect(firstSeq).toBe(1n);
    expect(secondSeq).toBe(2n);
    expect(await journal.headSeq(thread.id)).toBe(2n);

    const all = await journal.listByThread(thread.id);
    expect(all.map((entry) => entry.eventType)).toEqual(["turn.created", "stream.delta"]);
    expect(all[0]).toMatchObject({ threadId: thread.id, turnId: turn.id });

    await expect(journal.readAfter(thread.id, 1n)).resolves.toMatchObject([
      { seq: 2n, eventType: "stream.delta" },
    ]);
    await expect(journal.listByType(thread.id, "stream.delta")).resolves.toHaveLength(1);
    await expect(journal.listSince(thread.id, all[0].id)).resolves.toMatchObject([
      { id: all[1].id },
    ]);
    await expect(
      journal.listByTimeRange(thread.id, all[0].createdAt, all[1].createdAt),
    ).resolves.toHaveLength(2);
  });
});
