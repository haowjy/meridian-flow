import { describe, expect, it } from "vitest";
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { createAllowAllFileAccess } from "../../file-policy/index.js";
import { createNoopEventSink } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { ImageAssetResolutionError } from "../ports/image-asset.js";
import { createContextImageAssetPort } from "./context-image-assets.js";

const context = {
  threadId: "thread-1",
  projectId: "project-1",
  actorUserId: "user-1",
};
const reference = {
  type: "image_reference" as const,
  documentId: "document-1",
  uri: "uploads://@/image.png",
};

function assetPort(input: {
  availability: { kind: string; entry?: { uri: string } };
  failure?: "availability" | "identity" | "object";
  identity?: {
    mimeType: string | null;
    storageUrl: string | null;
    sizeBytes: number | null;
  } | null;
  object?:
    | { ok: true; value: { bytes: Uint8Array; mimeType: string } }
    | {
        ok: false;
        error: { code: string; message: string };
      };
}) {
  const availability = {
    async lookup() {
      if (input.failure === "availability") throw new Error("lookup failed");
      return { resolutions: [input.availability] };
    },
  } as unknown as ProjectContextAvailabilityPort;
  const identities = {
    async lookupDocument() {
      if (input.failure === "identity") throw new Error("identity failed");
      return input.identity === undefined
        ? { mimeType: "image/png", storageUrl: "object://meridian/image", sizeBytes: 5 }
        : input.identity;
    },
  } as unknown as UploadIdentityPort;
  const objects = {
    async get() {
      if (input.failure === "object") throw new Error("object read failed");
      return (
        input.object ?? {
          ok: true as const,
          value: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
        }
      );
    },
  } as unknown as ObjectStorePort;
  return createContextImageAssetPort({
    fileAccess: createAllowAllFileAccess(),
    availability,
    identities,
    objects,
    eventSink: createNoopEventSink(),
  });
}

describe("context image resolution", () => {
  it("resolves an available image with matching identity and object metadata", async () => {
    await expect(
      assetPort({
        availability: { kind: "available", entry: { uri: reference.uri } },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).resolves.toEqual({
      mediaType: "image/png",
      data: "AQID",
      sizeBytes: 3,
    });
  });

  it("treats not-visible as a definite loss", async () => {
    await expect(
      assetPort({ availability: { kind: "not-visible" } }).resolve(context, reference, {
        maxBytes: 1024,
      }),
    ).resolves.toBeNull();
  });

  it("treats authority-unavailable as a definite loss", async () => {
    await expect(
      assetPort({ availability: { kind: "authority-unavailable" } }).resolve(context, reference, {
        maxBytes: 1024,
      }),
    ).resolves.toBeNull();
  });

  it("treats deleted as a definite loss", async () => {
    await expect(
      assetPort({ availability: { kind: "deleted" } }).resolve(context, reference, {
        maxBytes: 1024,
      }),
    ).resolves.toBeNull();
  });

  it("treats a changed URI as a definite loss", async () => {
    await expect(
      assetPort({
        availability: { kind: "available", entry: { uri: "uploads://@/renamed.png" } },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).resolves.toBeNull();
  });

  it("throws only when availability is indeterminate", async () => {
    await expect(
      assetPort({ availability: { kind: "indeterminate" } }).resolve(context, reference, {
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ImageAssetResolutionError);
  });

  it.each([
    "availability",
    "identity",
    "object",
  ] as const)("maps unexpected %s lookup failures to image resolution errors", async (failure) => {
    const error = await assetPort({
      availability: { kind: "available", entry: { uri: reference.uri } },
      failure,
    })
      .resolve(context, reference, { maxBytes: 1024 })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      name: "ImageAssetResolutionError",
      cause: { message: expect.stringMatching(/lookup failed|identity failed|object read failed/) },
    });
  });

  it("treats changed or non-image media types as definite loss", async () => {
    const available = { kind: "available", entry: { uri: reference.uri } };
    await expect(
      assetPort({
        availability: available,
        object: {
          ok: true,
          value: { bytes: new Uint8Array([1]), mimeType: "image/jpeg" },
        },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).resolves.toBeNull();
    await expect(
      assetPort({
        availability: available,
        identity: { mimeType: "text/plain", storageUrl: "object://meridian/image", sizeBytes: 1 },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).resolves.toBeNull();
  });

  it("treats not_found as a definite loss and other object-store errors as transient", async () => {
    const availability = { kind: "available", entry: { uri: reference.uri } };
    await expect(
      assetPort({
        availability,
        object: { ok: false, error: { code: "not_found", message: "missing" } },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).resolves.toBeNull();
    await expect(
      assetPort({
        availability,
        object: { ok: false, error: { code: "io_error", message: "offline" } },
      }).resolve(context, reference, { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(ImageAssetResolutionError);
  });
});
