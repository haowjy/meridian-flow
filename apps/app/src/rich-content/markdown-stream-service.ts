/** Worker transport and bounded ProseMirror identity caches for streaming text blocks. */

import type { MarkdownStreamResult } from "@meridian/markup";
import { Node as PMNode, type Schema } from "@tiptap/pm/model";
import type {
  MarkdownWorkerRequest,
  MarkdownWorkerResponse,
  OpenCodePath,
} from "./markdown-worker-protocol";

export type StreamingMarkdownSnapshot = {
  source: string;
  blocks: readonly PMNode[];
  openCode: PMNode | null;
  openCodeBlock: number;
};

type StreamState = {
  generation: number;
  seq: number;
  requestedSource: string;
  appliedSeq: number;
  nodes: Map<string, PMNode>;
  json: Map<string, string>;
  snapshot: StreamingMarkdownSnapshot | null;
  listeners: Set<() => void>;
};

let schema: Schema | undefined;
let parseStreaming: ((source: string) => MarkdownStreamResult) | undefined;
const states = new Map<string, StreamState>();
let nextGeneration = 1;
let worker: Worker | null | undefined;
let synchronous = typeof Worker === "undefined" || import.meta.env.SSR;

export function configureMarkdownStreaming(
  documentSchema: Schema,
  parse: (source: string) => MarkdownStreamResult,
): void {
  schema = documentSchema;
  parseStreaming = parse;
}

/** Start the module worker while the chat shell is mounting, before its first reply. */
export function prewarmMarkdownStreaming(): void {
  if (!synchronous) workerForBrowser();
}

export function subscribeStreamingMarkdown(streamId: string, listener: () => void): () => void {
  const state = stateFor(streamId);
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function requestStreamingMarkdown(streamId: string, source: string): void {
  const state = stateFor(streamId);
  if (state.requestedSource === source) return;
  state.requestedSource = source;
  state.seq++;
  if (synchronous) {
    applySynchronous(state, source);
    return;
  }
  const target = workerForBrowser();
  if (!target) {
    applySynchronous(state, source);
    return;
  }
  target.postMessage({
    type: "parse",
    streamId,
    generation: state.generation,
    seq: state.seq,
    source,
  } satisfies MarkdownWorkerRequest);
}

export function streamingMarkdownSnapshot(streamId: string): StreamingMarkdownSnapshot | null {
  return states.get(streamId)?.snapshot ?? null;
}

export function releaseStreamingMarkdown(streamId: string): void {
  const state = states.get(streamId);
  if (!state) return;
  states.delete(streamId);
  worker?.postMessage({
    type: "release",
    streamId,
    generation: state.generation,
  } satisfies MarkdownWorkerRequest);
}

/** Reuse the worker's exact nodes across the live-to-settled render when possible. */
export function settledStreamingMarkdown(
  streamId: string,
  source: string,
): StreamingMarkdownSnapshot | null {
  const snapshot = states.get(streamId)?.snapshot;
  return snapshot?.source === source ? snapshot : null;
}

function stateFor(streamId: string): StreamState {
  const existing = states.get(streamId);
  if (existing) return existing;
  const state: StreamState = {
    generation: nextGeneration++,
    seq: 0,
    requestedSource: "\0",
    appliedSeq: 0,
    nodes: new Map(),
    json: new Map(),
    snapshot: null,
    listeners: new Set(),
  };
  states.set(streamId, state);
  return state;
}

function workerForBrowser(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./markdown-stream.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<MarkdownWorkerResponse>) => receive(event.data);
    worker.onerror = disableWorker;
  } catch {
    disableWorker();
  }
  return worker ?? null;
}

function disableWorker(): void {
  worker?.terminate();
  worker = null;
  synchronous = true;
  for (const state of states.values()) {
    if (state.requestedSource !== "\0") applySynchronous(state, state.requestedSource);
  }
}

function receive(message: MarkdownWorkerResponse): void {
  const state = states.get(message.streamId);
  if (!state || state.generation !== message.generation) return;
  if (message.type === "error") {
    disableWorker();
    return;
  }

  for (const key of message.evicted) {
    state.nodes.delete(key);
    state.json.delete(key);
  }
  for (const [key, json] of Object.entries(message.nodes)) {
    if (!schema) throw new Error("Markdown streaming is not configured");
    state.nodes.set(key, PMNode.fromJSON(schema, json));
    // Worker responses already carry content keys. Keep JSON only for the
    // synchronous fallback, whose cacheNode path compares serialized nodes.
    if (synchronous) state.json.set(key, JSON.stringify(json));
  }
  if (message.seq < state.appliedSeq) return;
  const blocks = message.keys.map((key) => state.nodes.get(key));
  if (blocks.some((node) => !node)) {
    const source = state.requestedSource;
    state.requestedSource = "\0";
    requestStreamingMarkdown(message.streamId, source);
    return;
  }
  state.appliedSeq = message.seq;
  state.snapshot = {
    source: message.source,
    blocks: blocks as PMNode[],
    openCode: nodeAt(blocks as PMNode[], message.openCode),
    openCodeBlock: message.openCode?.block ?? -1,
  };
  notify(state);
}

function applySynchronous(state: StreamState, source: string): void {
  if (!parseStreaming) throw new Error("Markdown streaming is not configured");
  const result = parseStreaming(source);
  const keys = result.blocks.map((block) => cacheNode(state, block));
  const current = new Set(keys);
  for (const key of state.nodes.keys()) {
    if (state.nodes.size <= current.size + 128) break;
    if (current.has(key)) continue;
    state.nodes.delete(key);
    state.json.delete(key);
  }
  state.appliedSeq = state.seq;
  state.snapshot = {
    source,
    blocks: keys.map((key) => state.nodes.get(key) as PMNode),
    openCode: result.openCode,
    openCodeBlock: result.blocks.findIndex((block) => ownsNode(block, result.openCode)),
  };
  notify(state);
}

function cacheNode(state: StreamState, block: PMNode): string {
  const json = JSON.stringify(block.toJSON());
  const base = `${hash(json)}:${json.length}`;
  for (let collision = 0; ; collision++) {
    const key = collision === 0 ? base : `${base}:${collision}`;
    const known = state.json.get(key);
    if (known === json) return key;
    if (known === undefined) {
      state.json.set(key, json);
      state.nodes.set(key, block);
      return key;
    }
  }
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

function nodeAt(blocks: readonly PMNode[], locator: OpenCodePath): PMNode | null {
  if (!locator) return null;
  let node: PMNode | undefined = blocks[locator.block];
  if (!node) return null;
  for (const index of locator.path) {
    node = node.maybeChild(index) ?? undefined;
    if (!node) return null;
  }
  return node;
}

function ownsNode(block: PMNode, target: PMNode | null): boolean {
  if (!target) return false;
  if (block === target) return true;
  let found = false;
  block.descendants((node) => {
    if (node === target) found = true;
    return !found;
  });
  return found;
}

function notify(state: StreamState): void {
  for (const listener of state.listeners) listener();
}
