import { createAgentEditCodecFactory, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import {
  applyCommandEffects,
  documentEditParts,
  documentEdits,
  documentYjsCheckpoints,
  documentYjsUpdates,
  pushLineage,
} from "@meridian/database/schema";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { loadDocumentIdentityRows } from "../../context/tree/tree-view-sql.js";
import { describeTrailBlocks, trailBlockChanges } from "../domain/document-difference.js";
import { preparedTrailChanges } from "../domain/draft-trail-projection.js";
import type { DocumentLinkScopes } from "../domain/ports/document-link-scope.js";
import {
  foldTrailChanges,
  type NormalizedTrail,
  type RawTrailChange,
} from "../domain/trail-read-kernel.js";
import { resolveEditOwners } from "./drizzle-edit-owners.js";

type Owner = NormalizedTrail["owner"];
const ownerKey = (owner: Owner) => `${owner.threadId}:${owner.turnId ?? "shared"}`;
export async function canonicalTrailOwners(
  db: Database,
  owners: readonly { threadId: string; turnId: string | null }[],
): Promise<Owner[]> {
  const resolved = await resolveEditOwners(
    currentDrizzleDb(db),
    owners.map((owner) => owner.threadId),
  );
  return owners.map((owner) => {
    const writer = resolved.get(owner.threadId);
    const threadId = writer?.threadId ?? owner.threadId;
    const turnId = writer?.spawn?.turnId ?? owner.turnId;
    return turnId ? { kind: "turn", threadId, turnId } : { kind: "shared", threadId, turnId: null };
  });
}

export function createDrizzleTrailProjection(db: Database, links?: DocumentLinkScopes) {
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codecs = createAgentEditCodecFactory(mdxCodec({ schema }));
  return async (owner: Owner) => {
    const tx = currentDrizzleDb(db);
    const writers = await tx.execute<{ id: string }>(sql`
      WITH RECURSIVE writers AS (
        SELECT id FROM threads WHERE id = ${owner.threadId}::uuid
        UNION ALL SELECT child.id FROM threads child JOIN writers parent ON child.parent_thread_id = parent.id WHERE child.kind <> 'primary'
      ) SELECT id FROM writers
    `);
    const roots = writers.length
      ? await tx
          .select({
            documentId: documentEdits.documentId,
            threadId: documentEdits.threadId,
            turnId: documentEdits.turnId,
          })
          .from(documentEdits)
          .where(
            sql`${documentEdits.actor} = 'agent' AND ${inArray(
              documentEdits.threadId,
              writers.map((writer) => writer.id),
            )}`,
          )
      : [];
    const rootOwners = await canonicalTrailOwners(
      db,
      roots.flatMap((row) =>
        row.threadId ? [{ threadId: row.threadId, turnId: row.turnId }] : [],
      ),
    );
    const applied = await tx
      .select()
      .from(applyCommandEffects)
      .where(
        sql`${applyCommandEffects.owners} @> ${JSON.stringify([{ threadId: owner.threadId, turnId: owner.turnId }])}::jsonb`,
      );
    const documentIds = [
      ...new Set([
        ...roots
          .filter((_row, index) => ownerKey(rootOwners[index]) === ownerKey(owner))
          .map((row) => row.documentId),
        ...applied.map((effect) => effect.documentId),
      ]),
    ];
    const raw: RawTrailChange[] = [];
    const documentTitles = new Map<string, string>();
    for (const documentId of documentIds) {
      const rows = await tx
        .select({ part: documentEditParts, edit: documentEdits })
        .from(documentEditParts)
        .innerJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
        .where(eq(documentEdits.documentId, documentId))
        .orderBy(documentEditParts.id);
      const storedEffects = await tx
        .select()
        .from(applyCommandEffects)
        .where(eq(applyCommandEffects.documentId, documentId));
      if (storedEffects.some((effect) => effect.liveUpdateSeq !== null && effect.owners === null))
        throw new Error(`Missing Apply trail ownership evidence for document ${documentId}`);
      const effects = await Promise.all(
        storedEffects.map(async (effect) => ({
          ...effect,
          owners: await canonicalTrailOwners(db, effect.owners ?? []),
        })),
      );
      const pushes = await tx
        .select()
        .from(pushLineage)
        .where(eq(pushLineage.documentId, documentId));
      const pushByCommand = new Map(pushes.map((push) => [push.idempotencyKey, push]));
      const bySeq = new Map(
        effects.flatMap((effect) =>
          effect.liveUpdateSeq === null ? [] : [[effect.liveUpdateSeq, effect] as const],
        ),
      );
      const authorRows = rows.filter((row) => row.edit.actor === "agent" && row.edit.threadId);
      const resolved = await canonicalTrailOwners(
        db,
        authorRows.map((row) => ({
          threadId: row.edit.threadId as string,
          turnId: row.edit.turnId,
        })),
      );
      const authors = new Map(authorRows.map((row, index) => [row.edit.id, resolved[index]]));
      const byPart = new Map(rows.map((row) => [`${row.edit.id}:${row.part.ordinal}`, row]));
      const ownership = new Map<string, Owner[]>();
      const partOwners = (row: (typeof rows)[number], seen = new Set<string>()): Owner[] => {
        const key = `${row.edit.id}:${row.part.ordinal}`;
        const cached = ownership.get(key);
        if (cached) return cached;
        if (seen.has(key)) throw new Error("Cyclic trail receipt targets");
        const next = new Set([...seen, key]);
        const own = authors.get(row.edit.id);
        const reached = [
          ...(row.part.origin.kind === "live"
            ? (bySeq.get(row.part.origin.seq)?.owners ?? []).map((source) =>
                source.turnId
                  ? { kind: "turn" as const, threadId: source.threadId, turnId: source.turnId }
                  : { kind: "shared" as const, threadId: source.threadId, turnId: null },
              )
            : []),
          ...row.part.targets.flatMap((target) => {
            const original = byPart.get(`${target.editId}:${target.ordinal}`);
            return original ? partOwners(original, next) : [];
          }),
        ];
        const all = [
          ...new Map(
            [...(own ? [own] : []), ...reached].map((item) => [ownerKey(item), item]),
          ).values(),
        ];
        ownership.set(key, all);
        return all;
      };
      const live = rows
        .filter((row) => row.part.origin.kind === "live")
        .sort(
          (a, b) =>
            (a.part.origin.kind === "live" ? a.part.origin.seq : 0) -
              (b.part.origin.kind === "live" ? b.part.origin.seq : 0) ||
            a.part.ordinal - b.part.ordinal ||
            a.part.id - b.part.id,
        );
      const selected = live.filter((row) =>
        partOwners(row).some((candidate) => ownerKey(candidate) === ownerKey(owner)),
      );
      if (!selected.length) continue;
      const [title] = await loadDocumentIdentityRows(tx, [documentId]);
      documentTitles.set(documentId, title?.name ?? "Document");
      const checkpoints = await tx
        .select({
          id: documentYjsCheckpoints.id,
          authorityId: documentYjsCheckpoints.authorityId,
          authorityGeneration: documentYjsCheckpoints.authorityGeneration,
          upToSeq: documentYjsCheckpoints.upToSeq,
        })
        .from(documentYjsCheckpoints)
        .where(eq(documentYjsCheckpoints.documentId, documentId));
      const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
      const transport = await tx
        .select()
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, documentId));
      const transportBySeq = new Map(transport.map((row) => [row.id, row]));
      const aliases = live.flatMap(({ part }) => part.aliases).reverse();
      const original = (identity: { clientID: number; clock: number }) => {
        let current = identity;
        const seen = new Set<string>();
        for (;;) {
          const key = `${current.clientID}:${current.clock}`;
          if (seen.has(key)) throw new Error("Cyclic trail restoration aliases");
          seen.add(key);
          const alias = aliases.find(
            (candidate) =>
              candidate.target.client === current.clientID &&
              candidate.target.clock <= current.clock &&
              current.clock < candidate.target.clock + candidate.len,
          );
          if (!alias) return current;
          current = {
            clientID: alias.source.client,
            clock: alias.source.clock + current.clock - alias.target.clock,
          };
        }
      };
      const generations = new Map<
        string,
        { basis: (typeof checkpoints)[number]; selected: typeof selected }
      >();
      for (const row of selected) {
        const origin = row.part.origin;
        if (origin.kind !== "live") continue;
        const decoded = Y.decodeUpdate(row.part.update);
        if (!decoded.structs.length && !decoded.ds.clients.size) continue;
        const basis =
          origin.checkpointId === undefined ? undefined : checkpointById.get(origin.checkpointId);
        if (!basis) throw new Error(`Missing trail checkpoint evidence for receipt ${row.edit.id}`);
        const key = `${basis.authorityId}:${basis.authorityGeneration}`;
        const generation = generations.get(key) ?? { basis, selected: [] };
        generation.selected.push(row);
        generations.set(key, generation);
      }
      for (const { basis, selected: members } of generations.values()) {
        const doc = createCollabYDoc({ gc: false });
        try {
          const [sourceCheckpoint] = await tx
            .select({ state: documentYjsCheckpoints.state })
            .from(documentYjsCheckpoints)
            .where(eq(documentYjsCheckpoints.id, basis.id));
          Y.applyUpdate(doc, sourceCheckpoint.state);
          const selectedIds = new Set(members.map((row) => row.part.id));
          const through = Math.max(
            ...members.map((row) => (row.part.origin.kind === "live" ? row.part.origin.seq : 0)),
          );
          const events = new Map<number, { parts: typeof live; update?: Uint8Array }>();
          for (const update of transport)
            if (
              update.authorityId === basis.authorityId &&
              update.authorityGeneration === basis.authorityGeneration &&
              update.id > basis.upToSeq &&
              update.id <= through
            )
              events.set(update.id, { parts: [], update: update.updateData });
          for (const row of live) {
            const at = row.part.origin;
            if (at.kind !== "live" || at.seq <= basis.upToSeq || at.seq > through) continue;
            const checkpoint =
              at.checkpointId === undefined ? undefined : checkpointById.get(at.checkpointId);
            const authority = checkpoint ?? transportBySeq.get(at.seq);
            if (!authority)
              throw new Error(`Missing trail authority evidence for receipt ${row.edit.id}`);
            if (
              authority.authorityId !== basis.authorityId ||
              authority.authorityGeneration !== basis.authorityGeneration
            )
              continue;
            const event = events.get(at.seq) ?? { parts: [] };
            event.parts.push(row);
            events.set(at.seq, event);
          }
          for (const [, event] of [...events].sort(([a], [b]) => a - b)) {
            for (const row of event.parts) {
              if (!selectedIds.has(row.part.id)) {
                Y.applyUpdate(doc, row.part.update);
                continue;
              }
              const origin = row.part.origin;
              if (origin.kind !== "live") continue;
              const frontier = Y.decodeStateVector(Y.encodeStateVector(doc));
              if (
                frontier.size !== Object.keys(row.part.frontier).length ||
                [...frontier].some(([client, clock]) => row.part.frontier[String(client)] !== clock)
              )
                throw new Error(`Incomplete trail source cut for receipt ${row.edit.id}`);
              if (!links) throw new Error("Trail projection requires document link scopes");
              await links.within({ documentId }, async () => {
                await links.prepare({
                  holders: [{ documentId, view: { kind: "live" } }],
                  docs: [doc],
                });
                const codec = codecs.forScope(links.holder({ documentId, view: { kind: "live" } }));
                const before = describeTrailBlocks(doc, model, codec);
                Y.applyUpdate(doc, row.part.update);
                await links.prepare({
                  holders: [{ documentId, view: { kind: "live" } }],
                  docs: [doc],
                });
                const after = describeTrailBlocks(doc, model, codec);
                const blocks = trailBlockChanges(before, after);
                const changes = preparedTrailChanges({
                  documentId,
                  changedBlocks: blocks,
                  receiptId: row.edit.id,
                  before: before.map((block) => ({
                    hash: block.id,
                    serialized: block.serialized,
                    ...block.identity,
                  })),
                  blockIdentities: new Map(
                    after.map((block) => [block.id, { documentId, ...block.identity }]),
                  ),
                  afterIds: new Set(after.map((block) => block.id)),
                  afterById: new Map(after.map((block) => [block.id, block.block])),
                  afterDoc: doc,
                });
                for (const change of changes) {
                  const identity = change.beforeBlockIdentity ?? change.afterBlockIdentity;
                  if (identity) {
                    const canonical = original(identity);
                    if (
                      canonical.clientID !== identity.clientID ||
                      canonical.clock !== identity.clock
                    )
                      change.beforeBlockIdentity = { documentId, ...canonical };
                  }
                  const push = pushByCommand.get(bySeq.get(origin.seq)?.commandId ?? "");
                  raw.push({
                    ...change,
                    pushId: push ? String(push.id) : null,
                    sequence: raw.length,
                  });
                }
              });
            }
            if (event.update) Y.applyUpdate(doc, event.update);
          }
        } finally {
          doc.destroy();
        }
      }
    }
    const changes = foldTrailChanges(raw);
    const trail: NormalizedTrail = {
      owner,
      changes,
      counts: {
        changes: changes.length,
        documents: new Set(changes.map((change) => change.documentId)).size,
      },
    };
    return { trails: [trail], documentTitles };
  };
}
