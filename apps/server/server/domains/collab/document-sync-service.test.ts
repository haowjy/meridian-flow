import { describe, expect, it } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";

import { createInMemoryDocumentStore } from "./adapters/in-memory/document-store.js";
import { createDocumentSyncService } from "./domain/document-sync-service.js";
import { buildFragmentCache } from "./domain/fragment-cache.js";
import { blockToMarkdown, markdownToNode, nodeToMarkdown } from "./domain/schemas.js";
import type { DocumentStore } from "./ports/document-store.js";

const DOC = "00000000-0000-0000-0000-000000000001";
const AGENT = "11111111-1111-1111-1111-111111111111";
function isOk<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
): result is { ok: true; value: T } {
  return result.ok;
}

function isErr<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E },
): result is { ok: false; error: E } {
  return !result.ok;
}

function unwrap<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  if (result.ok) return result.value;
  throw new Error(`Unexpected error result: ${JSON.stringify(result.error)}`);
}

/** Build a raw Yjs update simulating a frontend editor rewriting the doc. */
function clientUpdate(stateBytes: Uint8Array, newMarkdown: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stateBytes);
  const frag = doc.getXmlFragment("prosemirror");
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    updateYFragment(doc, frag, markdownToNode("document", newMarkdown), {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
  return Y.encodeStateAsUpdate(doc, before);
}

describe("DocumentSyncService — document schema", () => {
  it("seeds, normalizes markdown, and is idempotent on re-open", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());

    const first = unwrap(await service.getOrCreateMirror(DOC, "# Title\n\n- a\n- b", "markdown"));
    // prosemirror-markdown normalizes bullet markers to "*" (tight list).
    expect(first).toBe("# Title\n\n* a\n* b");

    const second = unwrap(await service.getOrCreateMirror(DOC, "ignored", "markdown"));
    expect(second).toBe(first);
  });

  it("applies an old→new edit and reflects it in readAsMarkdown", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    await service.getOrCreateMirror(DOC, "# Title\n\nFirst para.\n\nSecond para.", "markdown");

    const edit = await service.editFromMarkdown(DOC, "Second para.", "Edited para.", {
      type: "user",
      userId: "user_1",
    });
    expect(isOk(edit)).toBe(true);

    const md = unwrap(await service.readAsMarkdown(DOC));
    expect(md).toContain("Edited para.");
    expect(md).not.toContain("Second para.");
    expect(md).toContain("First para.");
  });

  it("returns edit_not_found and ambiguous_edit", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    await service.getOrCreateMirror(DOC, "alpha beta\n\nalpha gamma", "markdown");

    const missing = await service.editFromMarkdown(DOC, "zzz", "x", { type: "system" });
    expect(isErr(missing) && missing.error.code).toBe("edit_not_found");

    const ambiguous = await service.editFromMarkdown(DOC, "alpha", "x", { type: "system" });
    expect(isErr(ambiguous) && ambiguous.error.code).toBe("ambiguous_edit");
  });

  it("overwrites the whole document from markdown", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    await service.getOrCreateMirror(DOC, "old content", "markdown");

    await service.writeFromMarkdown(DOC, "# New\n\nFresh body.", { type: "user", userId: "u" });
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("# New\n\nFresh body.");
  });

  it("returns not_found for unmirrored documents", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    const read = await service.readAsMarkdown(DOC);
    expect(isErr(read) && read.error.code).toBe("not_found");
  });
});

describe("DocumentSyncService — code schema", () => {
  it("reads raw code with no markdown fencing and edits in place", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    const code = "import numpy as np\nx = 1\n";

    const seeded = unwrap(await service.getOrCreateMirror(DOC, code, "python"));
    expect(seeded).toBe(code);

    await service.editFromMarkdown(DOC, "x = 1", "x = 2", { type: "agent", actorTurnId: AGENT });
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("import numpy as np\nx = 2\n");
  });

  it("rebuilds code content from DB under the code schema", async () => {
    const store = createInMemoryDocumentStore();
    const writer = createDocumentSyncService(store);
    await writer.getOrCreateMirror(DOC, "def f():\n    return 1\n", "python");
    await writer.editFromMarkdown(DOC, "return 1", "return 2", { type: "system" });

    const reader = createDocumentSyncService(store);
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("def f():\n    return 2\n");
  });
});

describe("DocumentSyncService — persistence", () => {
  it("rebuilds identical markdown from DB after the live doc is discarded", async () => {
    const store = createInMemoryDocumentStore();
    const writer = createDocumentSyncService(store);
    await writer.getOrCreateMirror(DOC, "# Doc\n\nbody one", "markdown");
    await writer.writeFromMarkdown(DOC, "# Doc\n\nbody one\n\nbody two", { type: "system" });

    const reader = createDocumentSyncService(store);
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("# Doc\n\nbody one\n\nbody two");
  });

  it("rolls back append-log writes and live state when head advance fails", async () => {
    const store = createInMemoryDocumentStore();
    const writer = createDocumentSyncService(store, { compaction: false });
    await writer.getOrCreateMirror(DOC, "durable body", "markdown");

    let shouldFailHeadWrite = true;
    const failingStore: DocumentStore = {
      ...store,
      transaction<T>(fn: (transactionStore: DocumentStore) => Promise<T>): Promise<T> {
        return store.transaction((transactionStore) =>
          fn({
            ...transactionStore,
            async upsertHead(head) {
              if (shouldFailHeadWrite && head.latestUpdateSeq > 1) {
                shouldFailHeadWrite = false;
                throw new Error("injected head write failure");
              }
              await transactionStore.upsertHead(head);
            },
          }),
        );
      },
    };
    const failingWriter = createDocumentSyncService(failingStore, { compaction: false });

    await expect(
      failingWriter.writeFromMarkdown(DOC, "failed edit", { type: "system" }),
    ).rejects.toThrow("injected head write failure");

    const updatesAfterFailure = await store.listUpdatesAfter(DOC, 0);
    expect(updatesAfterFailure.map((update) => update.seq)).toEqual([1]);
    expect((await store.getHead(DOC))?.latestUpdateSeq).toBe(1);
    expect(unwrap(await failingWriter.readAsMarkdown(DOC))).toBe("durable body");

    await failingWriter.writeFromMarkdown(DOC, "successful edit", { type: "system" });
    expect(unwrap(await failingWriter.readAsMarkdown(DOC))).toBe("successful edit");

    const reader = createDocumentSyncService(store, { compaction: false });
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("successful edit");
  });

  it("rolls back head advancement and live state when auto-checkpoint insertion fails", async () => {
    const store = createInMemoryDocumentStore();
    const writer = createDocumentSyncService(store, { autoCheckpointEvery: 2, compaction: false });
    await writer.getOrCreateMirror(DOC, "durable body", "markdown");

    let shouldFailCheckpoint = true;
    const failingStore: DocumentStore = {
      ...store,
      transaction<T>(fn: (transactionStore: DocumentStore) => Promise<T>): Promise<T> {
        return store.transaction((transactionStore) =>
          fn({
            ...transactionStore,
            async insertCheckpoint(input) {
              if (shouldFailCheckpoint && input.upToSeq > 1) {
                shouldFailCheckpoint = false;
                throw new Error("injected checkpoint failure");
              }
              return transactionStore.insertCheckpoint(input);
            },
          }),
        );
      },
    };
    const failingWriter = createDocumentSyncService(failingStore, {
      autoCheckpointEvery: 2,
      compaction: false,
    });

    await expect(
      failingWriter.writeFromMarkdown(DOC, "failed checkpoint edit", { type: "system" }),
    ).rejects.toThrow("injected checkpoint failure");

    expect((await store.getHead(DOC))?.latestUpdateSeq).toBe(1);
    expect(await store.listUpdatesAfter(DOC, 0)).toHaveLength(1);
    expect(await store.listCheckpoints(DOC)).toHaveLength(0);
    expect(unwrap(await failingWriter.readAsMarkdown(DOC))).toBe("durable body");
  });
});

describe("DocumentSyncService — checkpoint and restore", () => {
  it("restores content to a named checkpoint, durably across rebuilds", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store);
    await service.getOrCreateMirror(DOC, "v1 body", "markdown");

    const restorePointId = unwrap(await service.checkpoint(DOC, "before risky change"));

    await service.writeFromMarkdown(DOC, "v1 body changed", { type: "user", userId: "u" });
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("v1 body changed");

    expect(isOk(await service.restore(DOC, restorePointId))).toBe(true);
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("v1 body");

    const reader = createDocumentSyncService(store);
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("v1 body");
  });

  it("lists named checkpoints newest first and rejects unknown restore points", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    await service.getOrCreateMirror(DOC, "v1", "markdown");
    await service.checkpoint(DOC, "first");
    await service.checkpoint(DOC, "second");

    const list = unwrap(await service.listCheckpoints(DOC));
    expect(list.map((c) => c.reason)).toEqual(["second", "first"]);

    const bad = await service.restore(DOC, "rp_missing");
    expect(isErr(bad) && bad.error.code).toBe("checkpoint_not_found");
  });
});

describe("DocumentSyncService — auto-checkpoint", () => {
  it("snapshots after the configured number of updates and stays rebuildable", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store, { autoCheckpointEvery: 2 });
    await service.getOrCreateMirror(DOC, "a", "markdown"); // seed = update #1
    await service.writeFromMarkdown(DOC, "a b", { type: "system" }); // #2 -> checkpoint

    expect(await store.getLatestCheckpoint(DOC)).not.toBeNull();

    await service.writeFromMarkdown(DOC, "a b c", { type: "system" });
    const reader = createDocumentSyncService(store);
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("a b c");
  });
});

describe("DocumentSyncService — transport (editor-facing)", () => {
  it("exposes the doc, applies frontend updates, and encodes state", async () => {
    const store = createInMemoryDocumentStore();
    const service = createDocumentSyncService(store);
    await service.getOrCreateMirror(DOC, "# T\n\nbody", "markdown");

    expect(isOk(await service.getDoc(DOC))).toBe(true);

    const state = unwrap(await service.encodeState(DOC));
    const update = clientUpdate(state, "# T\n\nbody edited by editor");
    const applied = await service.applyUpdate(DOC, update, { type: "user", userId: "u" });
    expect(isOk(applied)).toBe(true);
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("# T\n\nbody edited by editor");

    // Persisted: a fresh service rebuilds the editor's change.
    const reader = createDocumentSyncService(store);
    expect(unwrap(await reader.readAsMarkdown(DOC))).toBe("# T\n\nbody edited by editor");
  });

  it("maps malformed editor updates to corrupt_state and keeps the mirror usable", async () => {
    const service = createDocumentSyncService(createInMemoryDocumentStore());
    await service.getOrCreateMirror(DOC, "hello body", "markdown");

    const bad = await service.applyUpdate(DOC, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      type: "user",
      userId: "u",
    });
    expect(isErr(bad) && bad.error.code).toBe("corrupt_state");
    expect(unwrap(await service.readAsMarkdown(DOC))).toBe("hello body");
  });
});

describe("schemas — markdown isomorphism", () => {
  it("round-trips supported rich document markdown", () => {
    const md = [
      "# Heading",
      "",
      'A paragraph with **strong**, *em*, `code`, [link](https://example.com "title").\\',
      "Next line.",
      "",
      "> Quote line.",
      "",
      "* Bullet one",
      "* Bullet two",
      "",
      "3. Ordered one",
      "4. Ordered two",
      "",
      "```python",
      'print("hello")',
      "```",
    ].join("\n");

    const node = markdownToNode("document", md);
    expect(nodeToMarkdown("document", node)).toBe(md);
  });

  it("round-trips code as raw text", () => {
    const code = "for i in range(10):\n    print(i)\n";
    const node = markdownToNode("code", code);
    expect(nodeToMarkdown("code", node)).toBe(code);
    expect(node.firstChild?.type.name).toBe("code_block");
  });
});

describe("fragment-cache — position map", () => {
  it("joins per-block fragments into the full serialization with exact offsets", () => {
    const md = "# Title\n\nFirst.\n\nSecond.\n\n```py\nx = 1\n```";
    const root = markdownToNode("document", md);
    const cache = buildFragmentCache(root, "document");

    expect(cache.fullMarkdown).toBe(nodeToMarkdown("document", root));
    expect(cache.entries).toHaveLength(4);

    // markdownOffset points at the start of each fragment in fullMarkdown.
    for (const entry of cache.entries) {
      expect(
        cache.fullMarkdown.slice(
          entry.markdownOffset,
          entry.markdownOffset + entry.markdown.length,
        ),
      ).toBe(entry.markdown);
    }

    // pmPosition is the exact ProseMirror position of each top-level block.
    let pos = 0;
    root.forEach((child, offset, index) => {
      expect(cache.entries[index].pmPosition).toBe(offset);
      expect(offset).toBe(pos);
      pos += child.nodeSize;
    });
  });

  it("leaves untouched fragments byte-identical after a single-block edit", () => {
    const before = buildFragmentCache(
      markdownToNode("document", "# A\n\npara one\n\npara two"),
      "document",
    );
    const after = buildFragmentCache(
      markdownToNode("document", "# A\n\npara one\n\npara EDITED"),
      "document",
    );

    expect(after.entries[0].markdown).toBe(before.entries[0].markdown); // heading
    expect(after.entries[1].markdown).toBe(before.entries[1].markdown); // para one
    expect(after.entries[2].markdown).not.toBe(before.entries[2].markdown); // para two

    const para = markdownToNode("document", "lone").firstChild;
    expect(para && blockToMarkdown("document", para)).toBe("lone");
  });
});
