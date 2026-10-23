/** One owner for Markdown parse execution, identity reconciliation and settled snapshots. */

import { markdownCodec, type PresentationSourceRun } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Node as PMNode } from "@tiptap/pm/model";
import { createDocumentCache } from "./document-cache";
import {
  MarkdownParseSession,
  type MarkdownSnapshot,
  nodePath,
  reconcileSnapshot,
} from "./markdown-parse-session";
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol";

export type StreamingMarkdownSnapshot = MarkdownSnapshot<PMNode>;
export type SettledMarkdownDocument = {
  snapshot: StreamingMarkdownSnapshot;
  sourceMap: readonly PresentationSourceRun[];
};

type StreamState = {
  generation: number;
  seq: number;
  requestedSource: string;
  appliedSeq: number;
  session: MarkdownParseSession<PMNode>;
  snapshot: StreamingMarkdownSnapshot | null;
  listeners: Set<() => void>;
};

const schema = buildDocumentSchema();
const codec = markdownCodec({ schema });
const states = new Map<string, StreamState>();
const settledDocuments = createDocumentCache<StreamingMarkdownSnapshot>();
const presentationDocuments = createDocumentCache<SettledMarkdownDocument>();
let nextGeneration = 1;
let worker: Worker | null | undefined;
let synchronous = typeof Worker === "undefined" || import.meta.env.SSR;
let reportedWorkerFailure = false;

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
    if (state.appliedSeq < state.seq) applySynchronous(state, source);
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

export function settledMarkdownDocument(
  source: string,
  streamId: string | undefined,
  withPresentation: boolean,
): SettledMarkdownDocument {
  const parsed = withPresentation
    ? presentationDocuments(source, () => {
        const result = codec.parseWithSourceMap(source);
        return {
          snapshot: {
            source,
            blocks: result.blocks,
            openCode: nodePath(result.blocks, result.openCode),
          },
          sourceMap: result.sourceMap,
        };
      })
    : {
        snapshot: settledDocuments(source, () => {
          const result = codec.parseStreaming(source, { repair: false });
          return {
            source,
            blocks: result.blocks,
            openCode: nodePath(result.blocks, result.openCode),
          };
        }),
        sourceMap: [],
      };
  const live = streamId ? (states.get(streamId)?.snapshot ?? null) : null;
  return { ...parsed, snapshot: reconcileSnapshot(parsed.snapshot, live) };
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

function stateFor(streamId: string): StreamState {
  const existing = states.get(streamId);
  if (existing) return existing;
  const state: StreamState = {
    generation: nextGeneration++,
    seq: 0,
    requestedSource: "\0",
    appliedSeq: 0,
    session: new MarkdownParseSession(),
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
    worker.onerror = (event) =>
      disableWorker(event.error ?? new Error(event.message || "Markdown worker failed to load"));
    worker.onmessageerror = (event) => disableWorker(event);
  } catch (error) {
    disableWorker(error);
  }
  return worker ?? null;
}

function disableWorker(cause: unknown): void {
  if (!reportedWorkerFailure) {
    reportedWorkerFailure = true;
    console.error("Markdown worker failed; using synchronous parsing.", cause);
  }
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
    disableWorker(new Error(message.message));
    return;
  }
  if (message.seq < state.appliedSeq) return;
  const snapshot = state.session.apply(message, (json) => PMNode.fromJSON(schema, json));
  if (!snapshot) {
    const source = state.requestedSource;
    state.requestedSource = "\0";
    requestStreamingMarkdown(message.streamId, source);
    return;
  }
  state.appliedSeq = message.seq;
  state.snapshot = snapshot;
  notify(state);
}

function applySynchronous(state: StreamState, source: string): void {
  const result = codec.parseStreaming(source, { repair: true });
  state.appliedSeq = state.seq;
  state.snapshot = state.session.capture(
    source,
    result.blocks,
    result.openCode,
    (block) => block,
  ).snapshot;
  notify(state);
}

function notify(state: StreamState): void {
  for (const listener of state.listeners) listener();
}
