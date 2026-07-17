/** Postgres-backed coverage for independent figure asset identity. */

import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, folders, projects, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { createObjectStorageUrl } from "../../storage/object-storage-url.js";
import type { ObjectStorePort } from "../../storage/ports/object-store.js";
import { createDrizzleFigureDocumentRepository } from "../adapters/figures/drizzle-figure-document-repository.js";
import { createProductionUnifiedContextPortFactory } from "../unified-context-port-factory.js";
import { createFigureAssetService } from "./figure-assets.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("figure asset identity (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("figure asset identity (postgres)", () => {
    const USER_ID = "00000000-0000-4000-8000-000000000a01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a02";
    const SOURCE_ID = "00000000-0000-4000-8000-000000000a03";
    const HOST_DOCUMENT_ID = "00000000-0000-4000-8000-000000000a04";
    const ASSET_KEY_ID = "00000000-0000-4000-8000-000000000a05";
    const db = createDb(DATABASE_URL, { max: 4 });
    const storedObjects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
    const objectStore: ObjectStorePort = {
      async put(key, bytes, mimeType) {
        storedObjects.set(key, { bytes, mimeType });
        return { ok: true, value: { storageUrl: createObjectStorageUrl(key) } };
      },
      async get(key) {
        const stored = storedObjects.get(key);
        return stored
          ? { ok: true, value: stored }
          : { ok: false, error: { code: "not_found", message: "not found" } };
      },
      async list() {
        return { ok: true, value: { keys: [] } };
      },
      async getSignedUrl(key) {
        return storedObjects.has(key)
          ? { ok: true, value: `https://assets.test/${key}` }
          : { ok: false, error: { code: "not_found", message: "not found" } };
      },
      async delete(key) {
        storedObjects.delete(key);
        return { ok: true, value: undefined };
      },
    };

    beforeEach(async () => {
      storedObjects.clear();
      await truncateDrizzleTables(db, [documents, folders, contextSources, projects, users]);
      await db.insert(users).values(conformanceUserValues(USER_ID, "figure-asset-identity"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Figure Asset Identity",
        slug: "figure-asset-identity",
      });
      await db.insert(contextSources).values({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      });
      await db.insert(documents).values({
        id: HOST_DOCUMENT_ID,
        contextSourceId: SOURCE_ID,
        name: "chapter-one",
        extension: "md",
        fileType: "markdown",
        mimeType: "text/markdown",
        sizeBytes: 23,
        markdownProjection: "# Chapter One\n\nIt began.",
      });
    });

    afterAll(async () => db.$client.end());

    it("creates a distinct binary asset without changing the host document", async () => {
      const contextPorts = createProductionUnifiedContextPortFactory({
        db,
        documentSync: {} as never,
        manifestMembership: {
          async recordManifestDocumentCreated() {},
          async recordManifestDocumentDeleted() {},
        },
      });
      const service = createFigureAssetService({
        objectStore,
        documents: createDrizzleFigureDocumentRepository({ db }),
        contextPorts,
        generateId: () => ASSET_KEY_ID,
        signedUrlExpiresAt: () => "2030-01-01T00:00:00.000Z",
        eventSink: {
          emit() {},
          emitBatch() {},
          async flush() {},
        },
      });
      const [before] = await db.select().from(documents).where(eq(documents.id, HOST_DOCUMENT_ID));
      const hostBefore = {
        fileType: before?.fileType,
        storageUrl: before?.storageUrl,
        mimeType: before?.mimeType,
        sizeBytes: before?.sizeBytes,
        markdownProjection: before?.markdownProjection,
      };

      const uploaded = await service.uploadFigure({
        projectId: PROJECT_ID,
        userId: USER_ID,
        hostDocumentId: HOST_DOCUMENT_ID,
        bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        mimeType: "image/png",
        filename: "map.png",
      });

      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      expect(uploaded.value.assetDocumentId).not.toBe(HOST_DOCUMENT_ID);
      expect(uploaded.value.figure.src).toBe(`asset:${uploaded.value.assetDocumentId}`);

      const [after] = await db.select().from(documents).where(eq(documents.id, HOST_DOCUMENT_ID));
      expect(after).toEqual(before);
      expect({
        fileType: after?.fileType,
        storageUrl: after?.storageUrl,
        mimeType: after?.mimeType,
        sizeBytes: after?.sizeBytes,
        markdownProjection: after?.markdownProjection,
      }).toEqual(hostBefore);

      const context = contextPorts.forProject(PROJECT_ID, USER_ID);
      await expect(context.stat("manuscript://chapter-one.md")).resolves.toMatchObject({
        ok: true,
        value: { kind: "tracked" },
      });
      await expect(
        context.stat(`manuscript://assets/${ASSET_KEY_ID}-map.png`),
      ).resolves.toMatchObject({ ok: true, value: { kind: "binary" } });

      const signed = await service.getSignedFigureUrl({
        projectId: PROJECT_ID,
        assetDocumentId: uploaded.value.assetDocumentId,
      });
      expect(signed).toMatchObject({
        ok: true,
        value: {
          assetDocumentId: uploaded.value.assetDocumentId,
          signedUrl: expect.stringContaining("https://assets.test/"),
        },
      });
    });
  });
}
