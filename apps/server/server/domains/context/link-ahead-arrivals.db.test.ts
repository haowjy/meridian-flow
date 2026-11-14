/** Arrival hooks settle ahead refs once, against the final tree (contract §9.3–9.4, L1–L2). */

import { randomUUID } from "node:crypto";
import { aheadAddress } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  treeNodes,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { deleteAt, entryAt, moveTo } from "../../test-support/entry-ref.js";
import { NO_PROJECT_HINTS } from "../../test-support/project-hints.js";
import { createNoopEventSink } from "../observability/index.js";
import { processDetachedWork } from "../runtime/detached-work.js";
import { createInMemoryObjectStore, createObjectRelease } from "../storage/index.js";
import { createContextUploadContentPort } from "./uploads/context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "./uploads/drizzle-upload-intake.js";
import { createUploadIntake } from "./uploads/upload-intake.js";
import { uploadBytes } from "./uploads/upload-test-support.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("ahead-ref arrivals (postgres)", () => {
  // Registration and uploads commit in their own root transactions: committed-data isolation.
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await db.close();
  });

  const settlement = async (aheadId: string) => {
    const [row] = await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, aheadId));
    return row?.settledDocumentId ?? null;
  };

  it("create, upload, folder move-in and Work restore each settle once against the final tree", async () => {
    await deleteDrizzleRows(db, [users]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const workId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "ahead-arrivals"));
    await db.insert(projects).values({ id: projectId, userId, name: "Arrivals", slug: "arrivals" });
    await db.insert(works).values([
      { projectId, createdByUserId: userId, name: "No Work", isNoWork: true },
      { id: workId, projectId, createdByUserId: userId, name: "Branch", handle: "w1" },
    ]);
    await db.insert(contextSources).values([
      {
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      },
      { workId, name: "Scratch", slug: "scratch", scope: "work" },
    ]);
    const chatId = randomUUID();
    await db.insert(threads).values({
      id: chatId,
      projectId,
      rootThreadId: chatId,
      createdByUserId: userId,
      ref: "c1",
    });
    const ports = await createProductionAppPorts({
      backgroundTasks: processDetachedWork,
      db,
      eventSink: createNoopEventSink(),
      environment: { FLOW_OPENAI_API_KEY: "sk-test-ahead-arrivals" },
    });
    const app = composeAppServices(ports);
    try {
      const authority = await ports.workAuthorityResolver.byId(projectId, workId);
      if (!authority?.workHandle) throw new Error("Fixture Work missing");
      const port = app.contextPorts.forProject(
        projectId,
        userId,
        new Map([[authority.workHandle, authority]]),
      );
      const register = (address: string) => {
        const aheadId = randomUUID();
        return app.linkAheadRegistry
          .register([{ aheadId, holderProjectId: projectId as never, address }])
          .then(() => aheadId);
      };
      const create = async (uri: string) => {
        const created = await port.createTrackedDocument(uri, "");
        if (!created.ok) throw new Error(JSON.stringify(created.error));
        return created.value.documentId;
      };

      // Tracked create, then delete and recreate at the same path: the second never captures.
      const chapterAddress = aheadAddress("manuscript://ch1.md", "link");
      expect(chapterAddress).toBe("manuscript://ch1");
      const chapter = await register(chapterAddress ?? "");
      expect(await settlement(chapter)).toBeNull();
      const first = await create("manuscript://ch1");
      expect(await settlement(chapter)).toBe(first);
      const removed = await deleteAt(port, "manuscript://ch1", {
        expected: { kind: "file", nodeId: first },
      });
      if (!removed.ok) throw new Error(JSON.stringify(removed.error));
      const second = await create("manuscript://ch1");
      expect(second).not.toBe(first);
      expect(await settlement(chapter)).toBe(first);

      // A manuscript image: live membership is published after the upload commits.
      const image = await register("manuscript://art/map.png");
      const upload = await port.writeBinary("manuscript://art/map.png", {
        fileType: "image",
        storageUrl: "memory://map.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
      if (!upload.ok) throw new Error(JSON.stringify(upload.error));
      const [map] = await db
        .select({ id: treeNodes.id })
        .from(treeNodes)
        .where(and(eq(treeNodes.name, "map.png")));
      expect(await settlement(image)).toBe(map?.id);

      // Deleting a finalized upload keeps the identity it settled; a new upload at the same
      // address never captures the ref.
      const intakeStore = createInMemoryObjectStore();
      const intake = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(db, NO_PROJECT_HINTS),
        content: createContextUploadContentPort(app.contextPorts),
        objectStore: intakeStore,
        release: createObjectRelease({ objectStore: intakeStore, onFailure() {} }),
        eventSink: createNoopEventSink(),
      });
      for (const [filename, mimeType] of [
        ["delete-target.toml", "application/toml"],
        ["delete-target.png", "image/png"],
      ] as const) {
        const deletedRef = await register(`uploads://@c1/${filename}`);
        const bytes = new TextEncoder().encode(`Upload ${filename}`);
        const uploadOnce = async () => {
          const uploaded = await uploadBytes(intake, intakeStore, {
            actorUserId: userId,
            projectId,
            chatId,
            filename,
            mimeType,
            bytes,
          });
          if (!uploaded.ok) throw new Error(uploaded.error.code);
          return uploaded.value;
        };
        const firstUpload = await uploadOnce();
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
        expect
          .soft(
            await intake.deleteDraft({ documentId: firstUpload.documentId }, userId, {
              kind: "chat",
              projectId,
              chatId,
            }),
            filename,
          )
          .toEqual({ kind: "deleted" });
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
        const replacement = await uploadOnce();
        expect.soft(replacement.uri, filename).toBe(firstUpload.uri);
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
      }

      // Folder move-in settles against the moved tree; the ref at the vacated path stays put.
      const moved = await create("manuscript://branches/ch2.toml");
      const vacated = await register("manuscript://branches/ch2.toml");
      expect(await settlement(vacated)).toBe(moved);
      const destination = await register("manuscript://part-two/ch2.toml");
      expect(
        await moveTo(port, "manuscript://branches", "manuscript://part-two", {
          expected: await entryAt(port, "manuscript://branches"),
        }),
      ).toMatchObject({
        ok: true,
      });
      expect(await settlement(destination)).toBe(moved);
      expect(await settlement(vacated)).toBe(moved);

      // Work restore: the hidden document reappears at its address and settles the waiting ref.
      const notes = await create("scratch://@w1/notes.toml");
      await ports.workRepo.softDelete(workId as WorkId);
      // Registered while the Work is deleted: it keeps its identity, so the ref registers
      // against it and stays unsettled until the restore makes the address live again.
      const waiting = await register("scratch://@w1/notes.toml");
      expect(await settlement(waiting)).toBeNull();
      await ports.workRepo.restore(workId as WorkId);
      expect(await settlement(waiting)).toBe(notes);
    } finally {
      await app.shutdown();
    }
  });
});
