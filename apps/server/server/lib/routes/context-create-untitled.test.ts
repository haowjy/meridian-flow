/** Frozen HTTP meeting-point contract for client-first untitled materialization. */
import { describe, expect, it, vi } from "vitest";
import type { ContextPort } from "../../domains/context/index.js";
import {
  createUntitledContextDocument,
  parseCreateUntitledBody,
} from "../../routes/api/projects/[projectId]/context/[scheme]/create-untitled.post.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000101";

describe("create untitled route contract", () => {
  it("passes the client id and folder home to the port and returns the frozen response", async () => {
    const createUntitledDocument = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: "created" as const,
        documentId: DOCUMENT_ID,
        path: "drafts/Untitled 1.md",
        name: "Untitled 1",
      },
    }));

    await expect(
      createUntitledContextDocument({
        port: { createUntitledDocument } as unknown as ContextPort,
        userId: "writer-1",
        scheme: "manuscript",
        workId: null,
        body: parseCreateUntitledBody({ documentId: DOCUMENT_ID, folderPath: "drafts" }),
      }),
    ).resolves.toEqual({
      status: "created",
      documentId: DOCUMENT_ID,
      scheme: "manuscript",
      path: "drafts/Untitled 1.md",
      name: "Untitled 1",
    });
    expect(createUntitledDocument).toHaveBeenCalledWith("manuscript://drafts", {
      documentId: DOCUMENT_ID,
      origin: { type: "human", userId: "writer-1" },
    });
  });

  it("defaults the home to the scheme root", async () => {
    const createUntitledDocument = vi.fn(async () => ({
      ok: true as const,
      value: {
        status: "already-exists" as const,
        documentId: DOCUMENT_ID,
        path: "Untitled 1.md",
        name: "Untitled 1",
      },
    }));

    await createUntitledContextDocument({
      port: { createUntitledDocument } as unknown as ContextPort,
      userId: "writer-1",
      scheme: "manuscript",
      workId: null,
      body: parseCreateUntitledBody({ documentId: DOCUMENT_ID }),
    });

    expect(createUntitledDocument).toHaveBeenCalledWith("manuscript://", expect.any(Object));
  });
});
