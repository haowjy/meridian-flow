import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planBatches } from "./batching";
import { IMPORT_FILE_LIMITS } from "./limits";
import { buildManifest } from "./manifest";
import type { Selection } from "./selection";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function selectionOf(...roots: Selection["roots"]): Selection {
  return { roots, leftOut: [] };
}

describe("buildManifest", () => {
  it("describes each file by digest, sniff bytes and frontmatter text", async () => {
    const text = "---\naliases: [Old Wu]\n---\nBody";
    const { manifest, held } = await buildManifest(
      selectionOf({
        rootId: 0,
        kind: "folder",
        name: "vault",
        files: [
          { path: "Ch 1.md", file: new File([text], "Ch 1.md") },
          { path: "map.png", file: new File([new Uint8Array([137, 80, 78, 71])], "map.png") },
        ],
        folders: ["Empty"],
        unreadable: [{ path: "Gone.md", reason: "not_found" }],
        appJson: "{}",
      }),
      { importId: "00000000-0000-4000-8000-000000000000", destinationUri: "kb://" },
    );
    expect(manifest.roots).toEqual([{ rootId: 0, kind: "folder", name: "vault", appJson: "{}" }]);
    expect(manifest.folders).toEqual([{ rootId: 0, path: "Empty" }]);
    expect(manifest.unreadable).toEqual([{ rootId: 0, path: "Gone.md", reason: "not_found" }]);
    expect(manifest.entries[0]).toEqual({
      entryId: 0,
      rootId: 0,
      path: "Ch 1.md",
      size: text.length,
      sha256: sha(text),
      sniff: btoa(text),
      frontmatter: "aliases: [Old Wu]\n",
    });
    expect(manifest.entries[1].sniff).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
    expect(manifest.entries[1]).not.toHaveProperty("frontmatter");
    expect([...held.keys()]).toEqual([0, 1]);
  });

  it("reads frontmatter from extensionless and unknown-extension text, as the server classifies it", async () => {
    const text = "---\naliases: [Gate]\n---\nBody";
    const { manifest } = await buildManifest(
      selectionOf({
        rootId: 0,
        kind: "folder",
        name: "vault",
        files: [
          { path: "Chapter", file: new File([text], "Chapter") },
          { path: "notes.draft", file: new File([text], "notes.draft") },
          { path: "code.ts", file: new File([text], "code.ts") },
        ],
        folders: [],
        unreadable: [],
      }),
      { importId: "00000000-0000-4000-8000-000000000000", destinationUri: "kb://" },
    );
    expect(manifest.entries.map((entry) => entry.frontmatter)).toEqual([
      "aliases: [Gate]\n",
      "aliases: [Gate]\n",
      undefined,
    ]);
  });

  it("does not read a file over the limit and gives the same stand-in digest for the same size", async () => {
    const big = new File([new Uint8Array(IMPORT_FILE_LIMITS.fileBytes + 1)], "film.mp4");
    const read = { arrayBuffer: 0 };
    const original = big.arrayBuffer.bind(big);
    big.arrayBuffer = async () => {
      read.arrayBuffer += 1;
      return original();
    };
    const root = (file: File): Selection["roots"][number] => ({
      rootId: 0,
      kind: "file",
      name: "film.mp4",
      files: [{ path: "", file }],
      folders: [],
      unreadable: [],
    });
    const first = await buildManifest(selectionOf(root(big)), {
      importId: "a",
      destinationUri: "kb://",
    });
    const second = await buildManifest(
      selectionOf(root(new File([new Uint8Array(IMPORT_FILE_LIMITS.fileBytes + 1)], "film.mp4"))),
      { importId: "b", destinationUri: "kb://" },
    );
    expect(read.arrayBuffer).toBe(0);
    expect(first.manifest.entries[0].sha256).toBe(second.manifest.entries[0].sha256);
  });

  it("reports a file that cannot be read at hashing time as unreadable and holds the rest", async () => {
    const broken = new File(["x"], "Gone.md");
    broken.arrayBuffer = async () => {
      throw new DOMException("gone", "NotFoundError");
    };
    const { manifest, held } = await buildManifest(
      selectionOf({
        rootId: 0,
        kind: "folder",
        name: "vault",
        files: [
          { path: "Gone.md", file: broken },
          { path: "Here.md", file: new File(["y"], "Here.md") },
        ],
        folders: [],
        unreadable: [],
      }),
      { importId: "a", destinationUri: "kb://" },
    );
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["Here.md"]);
    expect(manifest.unreadable).toEqual([{ rootId: 0, path: "Gone.md", reason: "not_found" }]);
    expect([...held.values()].map((file) => file.path)).toEqual(["Here.md"]);
  });
});

describe("planBatches", () => {
  it("packs small files, sends a big one alone and never exceeds the part budget", () => {
    const small = Array.from({ length: 450 }, (_, entryId) => ({ entryId, size: 10 }));
    const batches = planBatches([
      ...small,
      { entryId: 900, size: IMPORT_FILE_LIMITS.requestBytes + 1 },
      { entryId: 901, size: 5 },
    ]);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50, 1, 1]);
    expect(batches[3][0].entryId).toBe(900);
  });

  it("starts a new request when the byte budget would be crossed", () => {
    const half = IMPORT_FILE_LIMITS.requestBytes / 2;
    const batches = planBatches([
      { entryId: 1, size: half },
      { entryId: 2, size: half },
      { entryId: 3, size: 1 },
    ]);
    expect(batches.map((batch) => batch.map((item) => item.entryId))).toEqual([[1, 2], [3]]);
  });
});
