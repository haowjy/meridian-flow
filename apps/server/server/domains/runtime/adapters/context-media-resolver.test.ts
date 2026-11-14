/**
 * Tests the Meridian Flow media resolver.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Access is checked on every resolve, so a file the thread can't read is never sent
 * - A link is asked of the object store; bytes are read only when the store has none
 */
import { describe, expect, it } from "vitest";
import type { ProjectContextAvailabilityPort, UploadIdentityPort } from "../../context/index.js";
import { createAllowAllFileAccess, type FileAccess } from "../../file-policy/index.js";
import { createNoopEventSink } from "../../observability/index.js";
import type { ObjectStorePort } from "../../storage/index.js";
import { MediaResolutionError } from "../ports/media-resolver.js";
import { createContextMediaResolver } from "./context-media-resolver.js";

const context = { threadId: "thread-1", projectId: "project-1", actorUserId: "user-1" };
const reference = { documentId: "document-1", uri: "uploads://@c1/image.png" };
const window = { startMs: 1_000_000, lengthSeconds: 3600 };

function resolver(input: {
  availability?: { kind: string; entry?: { uri: string; scope?: { kind: string } } };
  fileAccess?: Pick<FileAccess, "authorize">;
  link?: string | null;
  missingObject?: boolean;
  reads: string[];
}) {
  const availability = {
    async placed() {
      const answer = input.availability ?? { kind: "available", entry: { uri: reference.uri } };
      return {
        documents: new Map(answer.kind === "available" ? [[reference.documentId, answer]] : []),
        folders: new Map(),
        inconsistent: new Set(answer.kind === "indeterminate" ? [reference.documentId] : []),
      };
    },
  } as unknown as ProjectContextAvailabilityPort;
  const identities = {
    async lookupDocument() {
      return {
        name: "image.png",
        mimeType: "image/png",
        storageUrl: "object://meridian/uploads/p/d",
        sizeBytes: 3,
        hasPreview: false,
      };
    },
  } as unknown as UploadIdentityPort;
  const objects = {
    async getProviderReadLink(key: string, options: { signedAt: Date; expiresInSeconds: number }) {
      return {
        ok: true as const,
        value:
          input.link === undefined
            ? `https://bucket.example/${key}?signed=${options.signedAt.getTime()}&exp=${options.expiresInSeconds}`
            : input.link,
      };
    },
    async get(key: string) {
      input.reads.push(key);
      if (input.missingObject) {
        return { ok: false as const, error: { code: "not_found", message: "Object not found" } };
      }
      return {
        ok: true as const,
        value: { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" },
      };
    },
  } as unknown as ObjectStorePort;
  return createContextMediaResolver({
    fileAccess: input.fileAccess ?? createAllowAllFileAccess(),
    availability,
    identities,
    objects,
    eventSink: createNoopEventSink(),
  });
}

describe("context media resolution", () => {
  it("signs a link pinned to the window without reading bytes", async () => {
    const reads: string[] = [];
    const file = await resolver({ reads }).resolve(context, reference, window);
    expect(file).toMatchObject({ mediaType: "image/png", sizeBytes: 3, name: "image.png" });
    await expect(file?.source("original", "link")).resolves.toEqual({
      url: "https://bucket.example/uploads/p/d?signed=1000000&exp=7200",
    });
    expect(reads).toEqual([]);
  });

  it("reads the bytes when the store has no link a provider can reach", async () => {
    const reads: string[] = [];
    const file = await resolver({ reads, link: null }).resolve(context, reference, window);
    await expect(file?.source("original", "link")).resolves.toEqual({ data: "AQID" });
    expect(reads).toEqual(["uploads/p/d"]);
  });

  it("resolves nothing for a file the thread may no longer read", async () => {
    const denied = {
      async authorize() {
        return { denied: true as const, reason: "no_grant" };
      },
    } as unknown as FileAccess;
    await expect(
      resolver({ reads: [], fileAccess: denied }).resolve(context, reference, window),
    ).resolves.toBeNull();
  });

  it("keeps a moved or renamed file visible, since identity and the read grant decide", async () => {
    await expect(
      resolver({
        reads: [],
        availability: { kind: "available", entry: { uri: "uploads://@c1/renamed.png" } },
      }).resolve(context, reference, window),
    ).resolves.toMatchObject({ mediaType: "image/png" });
  });

  it("makes a missing stored object that file's outcome, not an error", async () => {
    const file = await resolver({ reads: [], missingObject: true, link: null }).resolve(
      context,
      reference,
      window,
    );
    await expect(file?.source("original", "bytes")).resolves.toBeNull();
    await expect(file?.source("original", "link")).resolves.toBeNull();
  });

  it("throws only when availability is indeterminate", async () => {
    await expect(
      resolver({ reads: [], availability: { kind: "indeterminate" } }).resolve(
        context,
        reference,
        window,
      ),
    ).rejects.toBeInstanceOf(MediaResolutionError);
  });
});
