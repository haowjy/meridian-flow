/** Behavioral coverage for offline journal reconciliation. */
import { createAgentEditCodec, toDocHandle, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { mergeTrailChanges } from "../adapters/drizzle-change-trail-aggregate.js";
import { planTrailForwardAction } from "../adapters/drizzle-trail-forward-actions.js";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createOfflineReconciliation } from "./offline-reconciliation.js";
import type { NormalizedTrail, TrailChangeV1 } from "./trail-read-kernel.js";

const DOCUMENT_ID = "doc-offline";
const THREAD_ID = "thread-offline";
const TURN_ID = "turn-agent";
const RESPONSE_ID = "response-agent";
const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);
const agentCodec = createAgentEditCodec(codec);

describe("offline reconciliation", () => {
  it("reports hidden writer content once using the ordinary swept trail shape", async () => {
    const scenario = await setup({
      origin: "human:writer",
      editDeletedBlock: true,
    });
    await scenario.reconcile();
    await scenario.reconcile();

    expect(scenario.changes).toHaveLength(1);
    expect(scenario.changes[0]).toMatchObject({
      documentId: DOCUMENT_ID,
      kind: "delete",
      navigation: { kind: "deletion_boundary" },
      writerProtection: { kind: "sweep" },
      swept: {
        removed: { status: "available", markdown: "Writer offline revision" },
      },
      reversible: false,
    });
    expect(
      planTrailForwardAction({
        liveDoc: scenario.liveDoc,
        change: scenario.changes[0] as TrailChangeV1,
        action: "restore",
        model,
        codec: agentCodec,
      }),
    ).not.toBeNull();
  });

  it("reports writer content using the ordinary recoverable trail", async () => {
    const scenario = await setup({
      origin: "human:writer",
      editDeletedBlock: true,
    });
    await scenario.reconcile();
    expect(scenario.changes).toHaveLength(1);
    expect(
      planTrailForwardAction({
        liveDoc: scenario.liveDoc,
        change: scenario.changes[0] as TrailChangeV1,
        action: "restore",
        model,
        codec: agentCodec,
      }),
    ).not.toBeNull();
  });

  it("reports an offline writer revision even when the block was agent-origin", async () => {
    const scenario = await setup({
      origin: "agent:earlier",
      editDeletedBlock: true,
    });
    await scenario.reconcile();
    expect(scenario.changes).toHaveLength(1);
    expect(scenario.changes[0]).toMatchObject({
      kind: "delete",
      writerProtection: { kind: "sweep" },
    });
  });
});

async function setup(input: { origin: string; editDeletedBlock: boolean }) {
  const journal = createInMemoryJournal();
  const initial = docFromMarkdown("Writer original");
  const initialUpdate = Y.encodeStateAsUpdate(initial);
  await journal.append(DOCUMENT_ID, initialUpdate, { origin: input.origin, seq: 0 });

  const agent = clone(initial);
  const agentVector = Y.encodeStateVector(agent);
  const agentBlock = model.getBlocks(toDocHandle(agent))[0];
  if (!agentBlock) throw new Error("missing agent block");
  model.deleteBlock(toDocHandle(agent), agentBlock);
  const agentUpdate = Y.encodeStateAsUpdate(agent, agentVector);
  await journal.append(DOCUMENT_ID, agentUpdate, {
    origin: `agent:${TURN_ID}`,
    actorTurnId: TURN_ID,
    authoringResponseId: RESPONSE_ID,
    seq: 0,
  });

  const offline = clone(initial);
  const offlineVector = Y.encodeStateVector(offline);
  if (input.editDeletedBlock) {
    const block = model.getBlocks(toDocHandle(offline))[0];
    if (!block) throw new Error("missing offline block");
    const replacement = codec.parse("Writer offline revision").blocks[0];
    if (!replacement) throw new Error("missing replacement block");
    model.applyBlockReplacement(toDocHandle(offline), block, replacement);
  } else {
    const block = model.getBlocks(toDocHandle(offline))[0];
    if (!block) throw new Error("missing offline block");
    model.insertBlocks(toDocHandle(offline), block, codec.parse("Disjoint offline note"));
  }
  const incomingUpdate = Y.encodeStateAsUpdate(offline, offlineVector);
  await journal.append(DOCUMENT_ID, incomingUpdate, { origin: "human:writer", seq: 0 });
  const converged = clone(agent);
  Y.applyUpdate(converged, incomingUpdate);

  let changes: TrailChangeV1[] = [];
  const reconciler = createOfflineReconciliation({
    journal,
    changeTrails: {
      async record(record) {
        const incoming = record.trails.flatMap((trail: NormalizedTrail) => trail.changes);
        changes = mergeTrailChanges(changes, incoming);
      },
    },
    model,
    codec: agentCodec,
    identifyUpdate: () => "incoming-identity",
    resolveThreadId: async () => THREAD_ID,
    resolveDocumentTitle: async () => "Chapter",
  });
  return {
    get changes() {
      return changes;
    },
    liveDoc: converged,
    reconcile: () =>
      reconciler.reconcile({
        documentId: DOCUMENT_ID,
        incomingUpdate,
        convergedState: Y.encodeStateAsUpdate(converged),
      }),
  };
}

function docFromMarkdown(markdown: string): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(doc), null, codec.parse(markdown));
  return doc;
}

function clone(source: Y.Doc): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}
