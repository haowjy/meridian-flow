// Wires the real @meridian/agent-edit core to the same in-memory fake ports
// the Node harness uses (see ../../fakes.ts). Shared between command panel,
// editor view, and tour runner.
import {
  type AgentEditCore,
  createAgentEditCodec,
  createAgentEditCore,
  type WriteContext,
  type YProsemirrorDocumentModel,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec } from "@meridian/markup";
import type { Schema } from "prosemirror-model";

import { InMemoryCoordinator, InMemoryJournal } from "../../fakes.js";
import { buildRenderSchema } from "./render-schema.js";

export interface PlaygroundEnv {
  core: AgentEditCore;
  journal: InMemoryJournal;
  coordinator: InMemoryCoordinator;
  model: YProsemirrorDocumentModel;
  schema: Schema;
  defaultContext: WriteContext;
}

export function createPlaygroundEnv(): PlaygroundEnv {
  // The render schema is structurally identical to the canonical schema
  // (same node names, attrs, content models, marks) but adds toDOM/parseDOM
  // so prosemirror-view can serialize. y-prosemirror only cares about the
  // structure, so this is safe.
  const schema = buildRenderSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const journal = new InMemoryJournal();
  const coordinator = new InMemoryCoordinator(journal);
  const defaultContext: WriteContext = {
    sessionId: "demo-session",
    threadId: "demo-thread",
  };
  const core = createAgentEditCore({
    journal,
    coordinator,
    lifecycle: coordinator,
    codec,
    model,
    defaultSessionId: defaultContext.sessionId,
    defaultThreadId: defaultContext.threadId,
  });
  return { core, journal, coordinator, model, schema, defaultContext };
}
