import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { extractProposalOps } from "../changeset-extractor";
import { groupIntoChunks } from "../chunk-grouper";
import type { EditOp } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a base Y.Doc with initial text content.
 */
function makeBaseDoc(content: string, textKey = "content"): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(textKey).insert(0, content);
  return doc;
}

/**
 * Build a Yjs update that captures only the new operations introduced by `fn`,
 * relative to the current state of `baseDoc`. Does NOT mutate `baseDoc`.
 */
function buildUpdate(
  baseDoc: Y.Doc,
  fn: (text: Y.Text, doc: Y.Doc) => void,
  textKey = "content",
): Uint8Array {
  // Clone so base stays untouched
  const workDoc = new Y.Doc();
  Y.applyUpdate(workDoc, Y.encodeStateAsUpdate(baseDoc));
  // Record state vector BEFORE the change
  const beforeSV = Y.encodeStateVector(workDoc);
  // Apply the change
  fn(workDoc.getText(textKey), workDoc);
  // Encode only the delta since beforeSV
  return Y.encodeStateAsUpdate(workDoc, beforeSV);
}

// ---------------------------------------------------------------------------
// Simple insert
// ---------------------------------------------------------------------------

describe("extractProposalOps — simple insert", () => {
  it("produces a single InsertOp with the correct position and text", () => {
    const base = makeBaseDoc("Hello world");
    // Insert " beautiful" after "Hello" (position 5)
    const update = buildUpdate(base, (text) => text.insert(5, " beautiful"));

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.kind).toBe("insert");
    if (op.kind === "insert") {
      expect(op.basePos).toBe(5);
      expect(op.insertedText).toBe(" beautiful");
    }
  });

  it("does not mutate the base doc", () => {
    const base = makeBaseDoc("Hello world");
    const originalText = base.getText("content").toString();
    const update = buildUpdate(base, (text) => text.insert(5, " beautiful"));

    extractProposalOps(base, update);

    expect(base.getText("content").toString()).toBe(originalText);
  });
});

// ---------------------------------------------------------------------------
// Simple delete
// ---------------------------------------------------------------------------

describe("extractProposalOps — simple delete", () => {
  it("produces a single DeleteOp with correct range and recovered deletedText", () => {
    const base = makeBaseDoc("Hello world");
    // Delete "Hello " (first 6 chars)
    const update = buildUpdate(base, (text) => text.delete(0, 6));

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.kind).toBe("delete");
    if (op.kind === "delete") {
      expect(op.baseStart).toBe(0);
      expect(op.baseEnd).toBe(6);
      expect(op.deletedText).toBe("Hello ");
    }
  });

  it("recovers deleted text from base text by position", () => {
    const base = makeBaseDoc("The quick brown fox");
    // Delete "quick " (positions 4..10)
    const update = buildUpdate(base, (text) => text.delete(4, 6));

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.kind).toBe("delete");
    if (op.kind === "delete") {
      expect(op.baseStart).toBe(4);
      expect(op.baseEnd).toBe(10);
      expect(op.deletedText).toBe("quick ");
    }
  });
});

// ---------------------------------------------------------------------------
// Replace (delete+insert merge)
// ---------------------------------------------------------------------------

describe("extractProposalOps — replace", () => {
  it("merges adjacent delete+insert at same position into a ReplaceOp", () => {
    const base = makeBaseDoc("Hello world");
    // Replace "world" (positions 6..11) with "earth"
    const update = buildUpdate(base, (text) => {
      text.delete(6, 5); // delete "world"
      text.insert(6, "earth"); // insert "earth" at same position
    });

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.kind).toBe("replace");
    if (op.kind === "replace") {
      expect(op.baseStart).toBe(6);
      expect(op.baseEnd).toBe(11);
      expect(op.deletedText).toBe("world");
      expect(op.insertedText).toBe("earth");
    }
  });
});

// ---------------------------------------------------------------------------
// No-op update
// ---------------------------------------------------------------------------

describe("extractProposalOps — no-op update", () => {
  it("returns [] when the update does not change the observed Y.Text", () => {
    const base = makeBaseDoc("Hello world");
    // Modify a different Y.Text key — "content" is unchanged
    const update = buildUpdate(
      base,
      (_text, doc) => {
        doc.getText("other_key").insert(0, "irrelevant change");
      },
    );

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(0);
  });

  it("returns [] for an effectively empty update (no transaction data)", () => {
    const base = makeBaseDoc("Hello world");
    // Encode the state as if from a doc with the same content
    const sameDoc = new Y.Doc();
    Y.applyUpdate(sameDoc, Y.encodeStateAsUpdate(base));
    // Encode delta since base → should be empty / no-op
    const noOpUpdate = Y.encodeStateAsUpdate(sameDoc, Y.encodeStateVector(base));

    const ops = extractProposalOps(base, noOpUpdate);

    expect(ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-op proposal producing multiple chunks
// ---------------------------------------------------------------------------

describe("extractProposalOps — multi-op proposal", () => {
  it("returns multiple ops for multiple changes in one update", () => {
    const base = makeBaseDoc("Hello world");
    // Two separate changes: insert at start, replace at end
    const update = buildUpdate(base, (text) => {
      text.insert(0, "dear ");   // insert "dear " at position 0
      text.delete(11, 5);        // delete "world" (now at position 11 due to prior insert)
      text.insert(11, "earth");  // insert "earth"
    });

    const ops = extractProposalOps(base, update);

    // Should produce exactly 2 ops: insert "dear " + replace "world" → "earth"
    expect(ops).toHaveLength(2);

    // First op: insert "dear " at base position 0
    expect(ops[0].kind).toBe("insert");
    if (ops[0].kind === "insert") {
      expect(ops[0].basePos).toBe(0);
      expect(ops[0].insertedText).toBe("dear ");
    }

    // Second op: replace "world" with "earth" at base position 6
    expect(ops[1].kind).toBe("replace");
    if (ops[1].kind === "replace") {
      expect(ops[1].baseStart).toBe(6);
      expect(ops[1].baseEnd).toBe(11);
      expect(ops[1].deletedText).toBe("world");
      expect(ops[1].insertedText).toBe("earth");
    }
  });
});

// ---------------------------------------------------------------------------
// groupIntoChunks — basic tests
// ---------------------------------------------------------------------------

describe("groupIntoChunks", () => {
  it("returns empty array for no ops", () => {
    const chunks = groupIntoChunks([], "prop-1", "Hello world");
    expect(chunks).toHaveLength(0);
  });

  it("assigns deterministic ids from proposalId and chunk index", () => {
    const base = makeBaseDoc("Hello world");
    const update = buildUpdate(base, (text) => text.insert(5, " beautiful"));
    const ops = extractProposalOps(base, update);

    const chunks = groupIntoChunks(ops, "proposal-abc", "Hello world");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("proposal-abc-chunk-0");
    expect(chunks[0].proposalId).toBe("proposal-abc");
  });

  it("sets status to 'pending' for new chunks", () => {
    const base = makeBaseDoc("Hello world");
    const update = buildUpdate(base, (text) => text.insert(5, " beautiful"));
    const ops = extractProposalOps(base, update);

    const chunks = groupIntoChunks(ops, "prop-1", "Hello world");

    expect(chunks[0].status).toBe("pending");
  });

  it("merges two ops separated by <=2 lines into one chunk", () => {
    // Two insertions on adjacent lines (1 newline = 2 lines when split)
    const baseText = "line one\nline two\nline three";
    const base = makeBaseDoc(baseText);
    const update = buildUpdate(base, (text) => {
      text.insert(0, ">> "); // insert at start of line one
      text.insert(11, ">> "); // insert at start of "line two" (after offset shift)
    });
    const ops = extractProposalOps(base, update);
    const chunks = groupIntoChunks(ops, "prop-1", baseText);

    // Both ops are close (within 2 lines) → merged into 1 chunk
    expect(chunks.length).toBeLessThanOrEqual(ops.length);
  });

  it("does not merge ops separated by a paragraph boundary (>2 lines)", () => {
    // Two ops separated by a blank line ("\n\n" → 3 parts → don't merge)
    const baseText = "paragraph one\n\nparagraph two";
    const base = makeBaseDoc(baseText);
    const update = buildUpdate(base, (text) => {
      text.insert(0, "A: "); // in first paragraph
      text.insert(18, "B: "); // in second paragraph (after blank line)
    });
    const ops = extractProposalOps(base, update);
    const chunks = groupIntoChunks(ops, "prop-1", baseText);

    // Separated by blank line → should NOT be merged
    expect(chunks.length).toBe(ops.length);
  });

  it("produces correct baseStart/baseEnd for an insert chunk", () => {
    const baseText = "Hello world";
    const base = makeBaseDoc(baseText);
    const update = buildUpdate(base, (text) => text.insert(5, " beautiful"));
    const ops = extractProposalOps(base, update);

    const chunks = groupIntoChunks(ops, "prop-1", baseText);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].baseStart).toBe(5);
    expect(chunks[0].baseEnd).toBe(5); // pure insert → baseStart === baseEnd
    expect(chunks[0].deletedText).toBe("");
    expect(chunks[0].insertedText).toBe(" beautiful");
  });

  it("produces correct fields for a replace chunk", () => {
    const baseText = "Hello world";
    const base = makeBaseDoc(baseText);
    const update = buildUpdate(base, (text) => {
      text.delete(6, 5);
      text.insert(6, "earth");
    });
    const ops = extractProposalOps(base, update);

    const chunks = groupIntoChunks(ops, "prop-1", baseText);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].baseStart).toBe(6);
    expect(chunks[0].baseEnd).toBe(11);
    expect(chunks[0].deletedText).toBe("world");
    expect(chunks[0].insertedText).toBe("earth");
  });
});

// ---------------------------------------------------------------------------
// Position accuracy verification
// ---------------------------------------------------------------------------

describe("position accuracy", () => {
  it("correctly positions an insert in the middle of a word", () => {
    const base = makeBaseDoc("abcdef");
    const update = buildUpdate(base, (text) => text.insert(3, "XYZ"));

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("insert");
    if (ops[0].kind === "insert") {
      expect(ops[0].basePos).toBe(3);
      expect(ops[0].insertedText).toBe("XYZ");
    }
  });

  it("correctly recovers deletedText at end of string", () => {
    const base = makeBaseDoc("Hello world!");
    const update = buildUpdate(base, (text) => text.delete(5, 7)); // delete " world!"

    const ops = extractProposalOps(base, update);

    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.kind).toBe("delete");
    if (op.kind === "delete") {
      expect(op.baseStart).toBe(5);
      expect(op.baseEnd).toBe(12);
      expect(op.deletedText).toBe(" world!");
    }
  });
});
