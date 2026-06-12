/** Shared conformance suite for thread document attachment and touch repositories. */
import { describe, expect, it } from "vitest";
import type { WorkbenchRepository } from "../../../workbenches/ports/workbench-repository.js";
import type { ThreadRepositories } from "../../ports/repositories.js";
import { THREAD_REPOSITORIES_CONFORMANCE_USER_ID } from "./thread-repositories.conformance.js";

export interface ThreadDocumentRepositoriesFixture {
  repos: ThreadRepositories;
  workbenches: WorkbenchRepository;
  createDocument(workbenchId: string, name: string): Promise<string>;
}

export function describeThreadDocumentRepositoriesConformance(
  name: string,
  makeFixture: () => ThreadDocumentRepositoriesFixture | Promise<ThreadDocumentRepositoriesFixture>,
): void {
  describe(`Thread document repositories conformance: ${name}`, () => {
    it("attaches, updates, lists, and detaches thread documents", async () => {
      const { repos, workbenches, createDocument } = await makeFixture();
      const workbench = await workbenches.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Workbench",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        workbenchId: workbench.id,
      });
      const documentId = await createDocument(workbench.id, "protocol.md");

      const attached = await repos.threadDocuments.attach(thread.id, documentId, "editing");
      expect(attached).toMatchObject({ threadId: thread.id, documentId, relationship: "editing" });
      expect(await repos.threadDocuments.listByThread(thread.id)).toMatchObject([
        { threadId: thread.id, documentId, relationship: "editing" },
      ]);

      const updated = await repos.threadDocuments.attach(thread.id, documentId, "reading");
      expect(updated.relationship).toBe("reading");
      expect(updated.firstTouchedAt).toBe(attached.firstTouchedAt);
      expect(updated.lastTouchedAt >= attached.lastTouchedAt).toBe(true);

      await repos.threadDocuments.detach(thread.id, documentId);
      await expect(repos.threadDocuments.listByThread(thread.id)).resolves.toEqual([]);
    });

    it("records per-turn document touches and lists most recent per document", async () => {
      const { repos, workbenches, createDocument } = await makeFixture();
      const workbench = await workbenches.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        title: "Workbench",
      });
      const thread = await repos.threads.create({
        userId: THREAD_REPOSITORIES_CONFORMANCE_USER_ID,
        workbenchId: workbench.id,
      });
      const firstTurn = await repos.turns.create({ threadId: thread.id, role: "assistant" });
      const secondTurn = await repos.turns.create({
        threadId: thread.id,
        prevTurnId: firstTurn.id,
        role: "assistant",
      });
      const firstDocumentId = await createDocument(workbench.id, "first.md");
      const secondDocumentId = await createDocument(workbench.id, "second.md");

      const firstTouch = await repos.documentTouches.recordTouch(firstTurn.id, firstDocumentId);
      const duplicateTurnTouch = await repos.documentTouches.recordTouch(
        firstTurn.id,
        firstDocumentId,
      );
      const secondDocumentTouch = await repos.documentTouches.recordTouch(
        firstTurn.id,
        secondDocumentId,
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      const newestFirstDocumentTouch = await repos.documentTouches.recordTouch(
        secondTurn.id,
        firstDocumentId,
      );

      expect(duplicateTurnTouch.id).toBe(firstTouch.id);
      expect(duplicateTurnTouch.touchedAt >= firstTouch.touchedAt).toBe(true);

      const touches = await repos.documentTouches.listByThread(thread.id);
      expect(touches.map((touch) => touch.documentId)).toEqual([
        newestFirstDocumentTouch.documentId,
        secondDocumentTouch.documentId,
      ]);
      expect(touches.find((touch) => touch.documentId === firstDocumentId)).toMatchObject({
        id: newestFirstDocumentTouch.id,
      });
      await expect(repos.documentTouches.listByThread(thread.id, 1)).resolves.toHaveLength(1);
    });
  });
}
