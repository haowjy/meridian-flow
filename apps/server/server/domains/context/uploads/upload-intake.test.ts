/** Conformance tests for the UploadIntake aggregate independent of adapters. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNoopEventSink } from "../../observability/index.js";
import type { UploadIntakeRepository, UploadReservation } from "./upload-intake.js";
import { classifyUpload, createUploadIntake } from "./upload-intake.js";

const bytes = new TextEncoder().encode("chapter one");
const digest = createHash("sha256").update(bytes).digest("hex");

function harness(owner: "work" | "none" = "none") {
  let row: UploadReservation | null = null;
  const repository: UploadIntakeRepository = {
    async reserve(input) {
      if (row)
        return row.fingerprint === input.fingerprint
          ? { kind: "existing", reservation: row }
          : { kind: "conflict" };
      row = {
        projectId: input.owner.projectId,
        intakeId: input.intakeId,
        documentId: "00000000-0000-4000-8000-000000000001",
        fingerprint: input.fingerprint,
        finalPath: input.filename,
        objectKey: "uploads/project/document",
        canonicalUri:
          owner === "work"
            ? `uploads://@revision-pass/${input.filename}`
            : `uploads://@/${input.filename}`,
        locationRevision: "revision-1",
        fileType: input.fileType,
        state: "reserved",
        storageUrl: null,
        consumed: false,
        owner:
          owner === "work"
            ? { kind: "work", workId: "work-1", workSlug: "revision-pass" }
            : { kind: "none" },
      };
      return { kind: "reserved", reservation: row };
    },
    async transaction(operation) {
      return operation();
    },
    async markObjectStored(_projectId, _intakeId, storageUrl) {
      if (row) row = { ...row, state: "object_stored", storageUrl };
    },
    async resetObjectStored() {
      if (row) row = { ...row, state: "reserved", storageUrl: null };
    },
    async lockForFinalize() {
      if (!row) throw new Error("missing");
      return row;
    },
    async finalize() {
      if (!row) throw new Error("missing");
      row = { ...row, state: "finalized" };
      return row;
    },
    async deleteDraft(input) {
      if (
        !row ||
        row.documentId !== input.documentId ||
        row.canonicalUri !== input.uri ||
        row.locationRevision !== input.expectedRevision
      )
        return { result: { kind: "identity_mismatch" } };
      if (row.consumed) return { result: { kind: "already_used" } };
      if (row.state === "deleted") return { result: { kind: "already_deleted" } };
      row = { ...row, state: "deleted" };
      return { result: { kind: "deleted" } };
    },
    async consume() {
      if (row) row = { ...row, consumed: true };
    },
  };
  const content = {
    persist: vi.fn<() => Promise<{ ok: true } | { ok: false; definite: boolean }>>(async () => ({
      ok: true,
    })),
  };
  const objectStore = {
    put: vi.fn(async () => ({ ok: true as const, value: { storageUrl: "object://upload" } })),
    delete: vi.fn(async () => ({ ok: true as const, value: undefined })),
    get: vi.fn(),
    list: vi.fn(),
    getSignedUrl: vi.fn(),
  };
  return {
    service: createUploadIntake({
      repository,
      content,
      objectStore,
      eventSink: createNoopEventSink(),
    }),
    content,
    objectStore,
  };
}

function input(owner: "work" | "none" = "none") {
  return {
    intakeId: "intake-1",
    actorUserId: "user-1",
    owner:
      owner === "work"
        ? { kind: "work" as const, projectId: "project-1", workId: "work-1" }
        : { kind: "none" as const, projectId: "project-1" },
    filename: "chapter.md",
    mimeType: "text/markdown",
    byteDigest: digest,
    bytes,
  };
}

describe("UploadIntake", () => {
  it.each([
    "none",
    "work",
  ] as const)("returns canonical %s authority and converges retries", async (owner) => {
    const { service, content } = harness(owner);
    const first = await service.intake(input(owner));
    const replay = await service.intake(input(owner));
    expect(first).toEqual(replay);
    expect(first.ok && first.value).toEqual({
      documentId: "00000000-0000-4000-8000-000000000001",
      uri: owner === "work" ? "uploads://@revision-pass/chapter.md" : "uploads://@/chapter.md",
      fileType: "markdown",
      locationRevision: "revision-1",
    });
    expect(content.persist).toHaveBeenCalledOnce();
  });

  it("rejects digest and fingerprint mismatches without a second write", async () => {
    const { service, content } = harness();
    await service.intake(input());
    expect(await service.intake({ ...input(), filename: "other.md" })).toEqual({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(await service.intake({ ...input(), byteDigest: "0".repeat(64) })).toEqual({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(content.persist).toHaveBeenCalledOnce();
  });

  it("stores binary bytes once and resumes the stable reservation", async () => {
    const { service, objectStore } = harness();
    const binary = new Uint8Array([0, 1, 2]);
    const result = await service.intake({
      ...input(),
      filename: "asset.bin",
      mimeType: "application/octet-stream",
      bytes: binary,
      byteDigest: createHash("sha256").update(binary).digest("hex"),
    });
    expect(result.ok && result.value.fileType).toBe("binary");
    expect(objectStore.put).toHaveBeenCalledOnce();
    await service.intake({
      ...input(),
      filename: "asset.bin",
      mimeType: "application/octet-stream",
      bytes: binary,
      byteDigest: createHash("sha256").update(binary).digest("hex"),
    });
    expect(objectStore.put).toHaveBeenCalledOnce();
  });

  it("compensates definite binary non-commit and reuses the same identity on recovery", async () => {
    const { service, content, objectStore } = harness();
    content.persist
      .mockResolvedValueOnce({ ok: false, definite: true })
      .mockResolvedValueOnce({ ok: true });
    const binary = new Uint8Array([0, 1, 2]);
    const request = {
      ...input(),
      filename: "asset.bin",
      mimeType: "application/octet-stream",
      bytes: binary,
      byteDigest: createHash("sha256").update(binary).digest("hex"),
    };
    expect(await service.intake(request)).toEqual({ ok: false, error: { code: "storage_failed" } });
    const recovered = await service.intake(request);
    expect(recovered.ok && recovered.value.documentId).toBe("00000000-0000-4000-8000-000000000001");
    expect(objectStore.delete).toHaveBeenCalledOnce();
    expect(objectStore.put).toHaveBeenCalledTimes(2);
  });

  it("retains stable stored bytes when transaction settlement is unknown", async () => {
    const { service, content, objectStore } = harness();
    content.persist.mockRejectedValueOnce(new Error("connection lost during commit"));
    const binary = new Uint8Array([0, 1, 2]);
    const request = {
      ...input(),
      filename: "asset.bin",
      mimeType: "application/octet-stream",
      bytes: binary,
      byteDigest: createHash("sha256").update(binary).digest("hex"),
    };
    expect(await service.intake(request)).toEqual({ ok: false, error: { code: "storage_failed" } });
    expect(objectStore.delete).not.toHaveBeenCalled();
    await service.intake(request);
    expect(objectStore.put).toHaveBeenCalledOnce();
  });

  it("identity/revision deletion cannot remove a replacement and consumption wins", async () => {
    const { service } = harness();
    const created = await service.intake(input());
    if (!created.ok) throw new Error("intake failed");
    expect(
      await service.deleteDraft(
        {
          intakeId: "intake-1",
          documentId: created.value.documentId,
          uri: created.value.uri,
          expectedRevision: "wrong",
        },
        "user-1",
      ),
    ).toEqual({ kind: "identity_mismatch" });
    await service.consume([created.value.documentId]);
    expect(
      await service.deleteDraft(
        {
          intakeId: "intake-1",
          documentId: created.value.documentId,
          uri: created.value.uri,
          expectedRevision: "revision-1",
        },
        "user-1",
      ),
    ).toEqual({ kind: "already_used" });
  });

  it("classifies text, images, and designation-only binaries on the server", () => {
    expect(classifyUpload({ filename: "notes.unknown", mimeType: "text/plain", bytes })).toBe(
      "text",
    );
    expect(
      classifyUpload({ filename: "cover.png", mimeType: "image/png", bytes: new Uint8Array([0]) }),
    ).toBe("image");
    expect(
      classifyUpload({
        filename: "archive.bin",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([0]),
      }),
    ).toBe("binary");
  });
});
