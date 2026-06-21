// End-to-end write(command=...) coverage with in-memory port fakes.
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { mdxCodec } from "../codec/presets/mdx.js";
import { createAgentEditCore } from "../index.js";
import { yProsemirrorModel } from "../model/y-prosemirror.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type {
  CompactionResult,
  JournalSnapshot,
  PersistedUpdate,
  ReversalRecord,
  UpdateMeta,
} from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import type { WriteContext } from "./types.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const context: WriteContext = { sessionId: "session-a", threadId: "thread-a" };

describe("write tool dispatch", () => {
  it("views block-hashed document content and scoped outline sections", async () => {
    const ctx = harness({ "chapter.md": "# Chapter\n\nAlpha sword.\n\n## Arena\n\nBeta waits." });

    const full = await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    expect(full).toMatch(/^[0-9a-f]{4}\|# Chapter/m);
    expect(full).toContain("|Alpha sword.");

    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 2);
    const section = await ctx.core.write(
      { command: "view", file: `chapter.md#${headingHash}` },
      context,
    );
    expect(section).toContain("|## Arena");
    expect(section).toContain("|Beta waits.");

    const outline = await ctx.core.write(
      { command: "view", file: "chapter.md", format: "outline" },
      context,
    );
    expect(outline).toContain(`write(command="view", file="chapter.md#${headingHash}")`);
  });

  it("creates a document with initial content", async () => {
    const ctx = harness();
    ctx.coordinator.createEmpty("new.md");

    const result = await ctx.core.write(
      { command: "create", file: "new.md", content: "# Draft\n\nOpening line." },
      context,
    );

    expect(result).toContain("status: success");
    expect(result).toContain("|# Draft");
    expect(blockTexts(ctx.liveDoc("new.md"))).toEqual(["Draft", "Opening line."]);
  });

  it("inserts by block hash, by find, and deduplicates tool_use_id", async () => {
    const ctx = harness({ "chapter.md": "Alpha.\n\nOmega." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const alphaHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const byHash = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "Inserted scene.", after: alphaHash },
      context,
    );

    expect(byHash).toContain("status: success");
    expect(byHash).toContain("Inserted scene.");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha.", "Inserted scene.", "Omega."]);

    const first = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );
    const replay = await ctx.core.write(
      {
        command: "insert",
        file: "chapter.md",
        content: "!",
        find: "Alpha",
        tool_use_id: "same-call",
      },
      context,
    );

    expect(replay).toBe(first);
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha!.");
  });

  it("replaces text, formatting, and deletes through replace(content='')", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword.\n\nDelete me." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const text = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(text).toBe("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))[0]).toBe("Alpha blade.");

    const formatted = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "**blade**", find: "blade" },
      context,
    );
    expect(formatted).toBe("status: success");
    expect(serializeDoc(ctx.liveDoc("chapter.md"))).toContain("Alpha **blade**.");

    const deleteHash = hashAt(ctx.liveDoc("chapter.md"), 1);
    const deletion = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "", in: deleteHash },
      context,
    );

    expect(deletion).toContain("status: success");
    expect(deletion).toContain(`deleted: ${deleteHash}`);
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("keeps find-based replacement reachable through file fragments", async () => {
    const ctx = harness({ "chapter.md": "# Arena\n\nsword here\n\n# After\n\nsword there" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    const headingHash = hashAt(ctx.liveDoc("chapter.md"), 0);

    const result = await ctx.core.write(
      { command: "replace", file: `chapter.md#${headingHash}`, content: "blade", find: "sword" },
      context,
    );

    expect(result).toBe("status: success");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual([
      "Arena",
      "blade here",
      "After",
      "sword there",
    ]);
  });

  it("undoes and redoes this thread's writes", async () => {
    const ctx = harness({ "chapter.md": "Alpha sword." });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);
    await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);

    const undo = await ctx.core.write({ command: "undo", file: "chapter.md" }, context);
    expect(undo).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha sword."]);

    const redo = await ctx.core.write({ command: "redo", file: "chapter.md" }, context);
    expect(redo).toContain("status: reversed");
    expect(blockTexts(ctx.liveDoc("chapter.md"))).toEqual(["Alpha blade."]);
  });

  it("returns LLM-readable not_found, ambiguous_match, and invalid_write errors", async () => {
    const ctx = harness({ "chapter.md": "sword one\n\nsword two" });
    await ctx.core.write({ command: "view", file: "chapter.md" }, context);

    const missing = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "x", after: "deadbeef" },
      context,
    );
    expect(missing).toContain("status: not_found");
    expect(missing).toContain('write(command="view", file="chapter.md")');

    const ambiguous = await ctx.core.write(
      { command: "replace", file: "chapter.md", content: "blade", find: "sword" },
      context,
    );
    expect(ambiguous).toContain("status: ambiguous_match");
    expect(ambiguous).toContain("Found 2 matches");

    const invalid = await ctx.core.write(
      { command: "insert", file: "chapter.md", content: "" },
      context,
    );
    expect(invalid).toContain("status: invalid_write");
    expect(invalid).toContain("insert requires non-empty content");
  });
});

function harness(initialDocs: Record<string, string> = {}) {
  const coordinator = new MemoryCoordinator(initialDocs);
  const journal = new MemoryJournal();
  for (const [docId, doc] of coordinator.docs)
    journal.setCheckpoint(docId, Y.encodeStateAsUpdate(doc));
  const core = createAgentEditCore({ journal, coordinator, codec, model });
  return {
    core,
    coordinator,
    journal,
    liveDoc: (docId: string) => coordinator.require(docId),
  };
}

class MemoryCoordinator implements DocumentCoordinator {
  readonly docs = new Map<string, Y.Doc>();

  constructor(initialDocs: Record<string, string>) {
    for (const [docId, markdown] of Object.entries(initialDocs)) {
      this.docs.set(docId, createDoc(markdown, 100 + this.docs.size));
    }
  }

  createEmpty(docId: string): Y.Doc {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 100 + this.docs.size;
    this.docs.set(docId, doc);
    return doc;
  }

  require(docId: string): Y.Doc {
    const doc = this.docs.get(docId);
    if (!doc) throw new Error(`missing doc ${docId}`);
    return doc;
  }

  async withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    return fn(this.require(docId));
  }

  async recover(_docId: string): Promise<void> {}
}

class MemoryJournal implements UpdateJournal {
  private readonly data = new Map<
    string,
    { checkpoint: Uint8Array | null; updates: PersistedUpdate[]; reversals: ReversalRecord[] }
  >();

  setCheckpoint(docId: string, checkpoint: Uint8Array): void {
    this.entry(docId).checkpoint = checkpoint;
  }

  async append(docId: string, update: Uint8Array, meta: UpdateMeta): Promise<number> {
    const entry = this.entry(docId);
    const seq = entry.updates.length + 1;
    if (meta.seq && meta.seq !== seq) throw new Error(`Expected seq ${seq}, got ${meta.seq}`);
    entry.updates.push({ seq, update, meta: { ...meta, seq } });
    return seq;
  }

  async read(
    docId: string,
    opts: { since?: number; until?: number } = {},
  ): Promise<JournalSnapshot> {
    const entry = this.entry(docId);
    return {
      checkpoint: entry.checkpoint,
      updates: entry.updates.filter(
        (update) =>
          (opts.since === undefined || update.seq >= opts.since) &&
          (opts.until === undefined || update.seq <= opts.until),
      ),
    };
  }

  async checkpoint(docId: string, state: Uint8Array): Promise<void> {
    this.entry(docId).checkpoint = state;
  }

  async compact(docId: string, _before: Date): Promise<CompactionResult> {
    const entry = this.entry(docId);
    const doc = new Y.Doc({ gc: false });
    if (entry.checkpoint) Y.applyUpdate(doc, entry.checkpoint);
    for (const update of entry.updates) Y.applyUpdate(doc, update.update);
    const updatesFolded = entry.updates.length;
    entry.checkpoint = Y.encodeStateAsUpdate(doc);
    entry.updates = [];
    return { updatesFolded, reversalsExpired: 0 };
  }

  async persistReversal(
    docId: string,
    undoUpdate: Uint8Array,
    record: ReversalRecord,
  ): Promise<void> {
    const seq = await this.append(docId, undoUpdate, { origin: "system", seq: 0 });
    record.undoUpdateSeq = seq;
    this.entry(docId).reversals.push({ ...record });
  }

  private entry(docId: string): {
    checkpoint: Uint8Array | null;
    updates: PersistedUpdate[];
    reversals: ReversalRecord[];
  } {
    let entry = this.data.get(docId);
    if (!entry) {
      entry = { checkpoint: null, updates: [], reversals: [] };
      this.data.set(docId, entry);
    }
    return entry;
  }
}

function createDoc(markdown: string, clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  const root = schema.node("doc", null, codec.parse(markdown).blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  doc.clientID = clientID;
  return doc;
}

function hashAt(doc: Y.Doc, index: number): string {
  const block = model.getBlocks(doc)[index];
  if (!block) throw new Error(`No block at ${index}`);
  return model.getBlockId(block);
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.getBlocks(doc).map((block) => model.toProsemirrorBlock(doc, block)));
}
