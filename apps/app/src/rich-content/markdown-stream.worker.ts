/** Canonical whole-source Markdown parsing off the browser main thread. */

import { markdownCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { MarkdownParseSession } from "./markdown-parse-session";
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdown-worker-protocol";

const codec = markdownCodec({ schema: buildDocumentSchema() });
const states = new Map<string, { generation: number; session: MarkdownParseSession<unknown> }>();
const pending = new Map<string, Extract<MarkdownWorkerRequest, { type: "parse" }>>();
let scheduled = false;

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
      state = { generation: request.generation, session: new MarkdownParseSession() };
      states.set(request.streamId, state);
    }
    const result = codec.parseStreaming(request.source, { repair: true });
    const { update } = state.session.capture(
      request.source,
      result.blocks,
      result.openCode,
      (block) => block.toJSON(),
    );
    post({
      type: "result",
      streamId: request.streamId,
      generation: request.generation,
      seq: request.seq,
      ...update,
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

function post(message: MarkdownWorkerResponse): void {
  self.postMessage(message);
}
