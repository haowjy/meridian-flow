// Shared assertions and document inspection helpers for write-tool tests.
import { expect } from "vitest";
import * as Y from "yjs";

import { renderAgentEditResult } from "../result-text.js";
import type { WriteOutcome, WriteStatus } from "../types.js";
import { codec, model } from "./write-tool-harness.js";

export function hashAt(doc: Y.Doc, index: number): string {
  const block = model.getBlocks(doc)[index];
  if (!block) throw new Error(`No block at ${index}`);
  return model.getBlockId(block);
}

export function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(doc).map((block) => model.getText(block));
}

/** The text the model sees for an outcome. */
export function outcomeText(output: string | WriteOutcome): string {
  return typeof output === "string" ? output : renderAgentEditResult(output.result);
}

export function expectOutcome(outcome: WriteOutcome, status: WriteStatus, isError = false): void {
  expect(outcome.status).toBe(status);
  expect(outcome.isError).toBe(isError);
}

/** The block bodies a result carries, without hashes. */
export function renderedBlockBodies(output: WriteOutcome): string[] {
  return output.result.blocks?.flatMap((group) => group.items.map((item) => item.body)) ?? [];
}

export function humanText(
  doc: Y.Doc,
  blockIndex: number,
  span: { from: number; to: number },
  text: string,
): void {
  const block = model.getBlocks(doc)[blockIndex];
  if (!block) throw new Error(`No block at ${blockIndex}`);
  doc.transact(
    () => {
      model.applyTextEdit(doc, block, span, text);
    },
    { type: "human" },
  );
}

export function humanDeleteBlock(doc: Y.Doc, blockIndex: number): void {
  const block = model.getBlocks(doc)[blockIndex];
  if (!block) throw new Error(`No block at ${blockIndex}`);
  doc.transact(
    () => {
      model.deleteBlock(doc, block);
    },
    { type: "human" },
  );
}

export function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.projectBlocks(doc));
}

export function documentBytes(doc: Y.Doc): number[] {
  return Array.from(Y.encodeStateAsUpdate(doc));
}
