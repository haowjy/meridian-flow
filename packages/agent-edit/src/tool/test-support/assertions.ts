// Shared assertions and document inspection helpers for write-tool tests.
import { expect } from "vitest";
import * as Y from "yjs";

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

export function outcomeText(output: string | WriteOutcome): string {
  return typeof output === "string" ? output : output.text;
}

export function expectOutcome(outcome: WriteOutcome, status: WriteStatus, isError = false): void {
  expect(outcome.status).toBe(status);
  expect(outcome.isError).toBe(isError);
}

export function expectNoInternalIds(text: string): void {
  expect(text).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
  expect(text).not.toContain("turn-");
}

export function renderedBlockBodies(output: string | WriteOutcome): string[] {
  const rendered = outcomeText(output);
  if (!rendered) return [];
  return rendered.split("\n").map((line) => line.replace(/^[0-9a-f]{4,}\|/, ""));
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

export function serializeDoc(doc: Y.Doc): string {
  return codec.serialize(model.projectBlocks(doc));
}

export function documentBytes(doc: Y.Doc): number[] {
  return Array.from(Y.encodeStateAsUpdate(doc));
}
