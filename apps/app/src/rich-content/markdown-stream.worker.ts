/** Canonical whole-source Markdown parsing off the browser main thread. */

import { markdownCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "@tiptap/pm/model";
import type {
  MarkdownWorkerRequest,
  MarkdownWorkerResponse,
  OpenCodePath,
} from "./markdown-worker-protocol";

const codec = markdownCodec({ schema: buildDocumentSchema() });
const states = new Map<string, { generation: number; sent: Map<string, string> }>();
const pending = new Map<string, Extract<MarkdownWorkerRequest, { type: "parse" }>>();
let scheduled = false;
const HISTORY_LIMIT = 128;

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const message = event.data;
  if (message.type === "release") {
    const state = states.get(message.streamId);
    if (state?.generation === message.generation) states.delete(message.streamId);
    const queued = pending.get(message.streamId);
    if (queued?.generation === message.generation) pending.delete(message.streamId);
    return;
  }
  const queued = pending.get(message.streamId);
  if (
    !queued ||
    message.generation > queued.generation ||
    (message.generation === queued.generation && message.seq > queued.seq)
  ) {
    pending.set(message.streamId, message);
  }
  if (!scheduled) {
    scheduled = true;
    setTimeout(drain, 0);
  }
};

function drain(): void {
  scheduled = false;
  const batch = [...pending.values()];
  pending.clear();
  for (const request of batch) parse(request);
  if (pending.size > 0 && !scheduled) {
    scheduled = true;
    setTimeout(drain, 0);
  }
}

function parse(request: Extract<MarkdownWorkerRequest, { type: "parse" }>): void {
  try {
    let state = states.get(request.streamId);
    if (!state || state.generation !== request.generation) {
      state = { generation: request.generation, sent: new Map() };
      states.set(request.streamId, state);
    }
    const result = codec.parseStreaming(request.source, { repair: true });
    const keys: string[] = [];
    const nodes: Record<string, unknown> = {};
    for (const block of result.blocks) {
      const json = JSON.stringify(block.toJSON());
      const key = contentKey(json, state.sent);
      keys.push(key);
      if (!state.sent.has(key)) nodes[key] = block.toJSON();
      state.sent.delete(key);
      state.sent.set(key, json);
    }

    const current = new Set(keys);
    const evicted: string[] = [];
    for (const key of state.sent.keys()) {
      if (state.sent.size <= current.size + HISTORY_LIMIT) break;
      if (current.has(key)) continue;
      state.sent.delete(key);
      evicted.push(key);
    }
    post({
      type: "result",
      streamId: request.streamId,
      generation: request.generation,
      seq: request.seq,
      source: request.source,
      keys,
      nodes,
      evicted,
      openCode: nodePath(result.blocks, result.openCode),
    });
  } catch (error) {
    post({
      type: "error",
      streamId: request.streamId,
      generation: request.generation,
      seq: request.seq,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function contentKey(json: string, sent: ReadonlyMap<string, string>): string {
  const base = `${hash(json)}:${json.length}`;
  for (let collision = 0; ; collision++) {
    const key = collision === 0 ? base : `${base}:${collision}`;
    const known = sent.get(key);
    if (known === undefined || known === json) return key;
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

function nodePath(blocks: readonly PMNode[], target: PMNode | null): OpenCodePath {
  if (!target) return null;
  for (let block = 0; block < blocks.length; block++) {
    const root = blocks[block];
    if (!root) continue;
    const found = descendantPath(root, target);
    if (found) return { block, path: found };
  }
  return null;
}

function descendantPath(node: PMNode, target: PMNode): number[] | null {
  if (node === target) return [];
  for (let index = 0; index < node.childCount; index++) {
    const path = descendantPath(node.child(index), target);
    if (path) return [index, ...path];
  }
  return null;
}

function post(message: MarkdownWorkerResponse): void {
  self.postMessage(message);
}
