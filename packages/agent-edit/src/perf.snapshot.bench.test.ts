// Baseline timing harness for the snapshot/render/find hot paths.
// Run: pnpm vitest run --root packages/agent-edit --testNamePattern "bench" 2>&1 | tail
// Not a regression gate — captures before/after numbers for Q1–Q4.

import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { describe, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { snapshotBlocks } from "./apply/echo.js";
import { createAgentEditCodec } from "./codec-adapter.js";
import { getBlockHash, lookupBlockHash } from "./model/block-hash.js";
import { yProsemirrorModel } from "./model/y-prosemirror.js";
import { serializeScopeBlocks } from "./resolver/find.js";
import { createDocumentRenderer } from "./tool/document-renderer.js";

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
const model = yProsemirrorModel(schema);
const renderer = createDocumentRenderer({ model, codec });

const BLOCK_COUNTS = [50, 100, 200, 400];
const WARMUP = 2;
const ITERATIONS = 5;

function ms(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1e6;
}

function time(label: string, fn: () => void, iterations = ITERATIONS): void {
  for (let i = 0; i < WARMUP; i++) fn();
  const runs: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime();
    fn();
    runs.push(ms(process.hrtime(start)));
  }
  const median = runs.sort((a, b) => a - b)[Math.floor(runs.length / 2)];
  const min = Math.min(...runs);
  const max = Math.max(...runs);
  console.log(
    `${label.padEnd(48)} median=${median.toFixed(2)}ms  min=${min.toFixed(2)}  max=${max.toFixed(2)}`,
  );
}

function buildChapterDoc(blockCount: number): Y.Doc {
  const paragraphs: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    if (i % 20 === 0) {
      paragraphs.push(`## Chapter Heading ${i}`);
    } else {
      const words = [];
      for (let w = 0; w < 60; w++) words.push(`word${i}_${w}`);
      paragraphs.push(words.join(" "));
    }
  }
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const parsed = codec.parse(paragraphs.join("\n\n"));
  const root = schema.node("doc", null, parsed.blocks);
  prosemirrorToYXmlFragment(root, doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return doc;
}

function buildLiveDoc(blockCount: number): Y.Doc {
  const doc = buildChapterDoc(blockCount);
  return doc;
}

function buildRuntimeFromLive(live: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 99;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
  doc.clientID = 99;
  return doc;
}

describe("snapshot cost baseline", () => {
  for (const blockCount of BLOCK_COUNTS) {
    it(`snapshotBlocks B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      time(`snapshotBlocks B=${blockCount}`, () => {
        snapshotBlocks(doc, model, codec);
      });
    });

    it(`renderBlockLines B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      time(`renderBlockLines B=${blockCount}`, () => {
        renderer.renderBlockLines(doc);
      });
    });

    it(`getBlockHash per-block loop B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      const blocks = model.getBlocks(doc);
      time(`getBlockHash loop B=${blockCount}`, () => {
        for (const block of blocks) getBlockHash(block);
      });
    });

    it(`lookupBlockHash (one lookup) B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      const blocks = model.getBlocks(doc);
      const targetHash = getBlockHash(blocks[Math.floor(blocks.length / 2)]);
      time(`lookupBlockHash single B=${blockCount}`, () => {
        lookupBlockHash(doc, targetHash);
      });
    });

    it(`serializeScopeBlocks full-doc find B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      const blocks = model.getBlocks(doc);
      const fullScope = {
        kind: "block" as const,
        blocks,
        startIndex: 0,
        endIndex: blocks.length - 1,
      };
      time(`serializeScopeBlocks full B=${blockCount}`, () => {
        serializeScopeBlocks({ doc, model, codec }, fullScope);
      });
    });

    it(`projectBlocks B=${blockCount}`, () => {
      const doc = buildLiveDoc(blockCount);
      time(`projectBlocks B=${blockCount}`, () => {
        model.projectBlocks(doc);
      });
    });
  }
});

describe("read reconstruction cost", () => {
  for (const blockCount of BLOCK_COUNTS) {
    it(`read rebuild (clone + render) B=${blockCount}`, () => {
      const live = buildLiveDoc(blockCount);
      time(`read clone+render B=${blockCount}`, () => {
        const runtime = buildRuntimeFromLive(live);
        renderer.renderBlockLines(runtime);
      });
    });
  }
});
