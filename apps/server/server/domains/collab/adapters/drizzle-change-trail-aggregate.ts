/** Drizzle persistence and terminal reconciliation for change-trail aggregates. */
import { createHash } from "node:crypto";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDeliveryOutbox,
  changeTrailDocumentDetails,
  changeTrailDocumentOccurrences,
  changeTrailShells,
  pushLineage,
} from "@meridian/database/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import type {
  ChangeTrailPersistence,
  CommittedChangeTrailProjection,
} from "../domain/ports/change-trail-persistence.js";

export type ChangeTrailAggregateWriter = ChangeTrailPersistence & {
  reconcileTerminalOwners(): Promise<void>;
};

import {
  canonicalChangeKey,
  type NormalizedTrail,
  type TrailChangeV1,
} from "../domain/trail-read-kernel.js";
import { wordDeltaBetweenHashlines } from "../domain/word-count.js";

function trailWordDelta(changes: readonly TrailChangeV1[]) {
  return changes.reduce(
    (total, change) => {
      const delta = wordDeltaBetweenHashlines(change.beforeText, change.afterTextAtReceipt);
      return {
        wordsAdded: total.wordsAdded + delta.wordsAdded,
        wordsRemoved: total.wordsRemoved + delta.wordsRemoved,
      };
    },
    { wordsAdded: 0, wordsRemoved: 0 },
  );
}

function deterministicUuid(namespace: string): string {
  const bytes = Buffer.from(createHash("sha256").update(namespace).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function trailIdForOwner(owner: NormalizedTrail["owner"]): string {
  return deterministicUuid(
    owner.kind === "turn"
      ? `change-trail:turn:${owner.threadId}:${owner.turnId}`
      : `change-trail:shared:${owner.threadId}`,
  );
}

export function mergeTrailChanges(
  existing: readonly TrailChangeV1[],
  incoming: readonly TrailChangeV1[],
): TrailChangeV1[] {
  const folded = new Map<string, TrailChangeV1>();
  const ordered = [
    ...[...existing].sort((a, b) => a.ordinal - b.ordinal),
    ...[...incoming].sort((a, b) => a.ordinal - b.ordinal),
  ];
  for (const change of ordered) {
    const key = canonicalChangeKey(change);
    const prior = folded.get(key);
    if (!prior) {
      folded.set(key, change);
      continue;
    }
    const combined: TrailChangeV1 = {
      ...change,
      changeId: prior.changeId,
      beforeBlockIdentity: prior.beforeBlockIdentity,
      beforeText: prior.beforeText,
      kind:
        prior.beforeText === null
          ? "insert"
          : change.afterTextAtReceipt === null
            ? "delete"
            : "modify",
    };
    if (combined.beforeText === combined.afterTextAtReceipt) folded.delete(key);
    else folded.set(key, combined);
  }
  return [...folded.values()].map((change, ordinal) => ({ ...change, ordinal }));
}

export function refinePushChanges(
  provisional: readonly TrailChangeV1[],
  contribution: readonly TrailChangeV1[],
): TrailChangeV1[] {
  const contributionKeys = new Set(contribution.map(canonicalChangeKey));
  const retained = provisional.filter(
    (change) => !contributionKeys.has(canonicalChangeKey(change)),
  );
  return mergeTrailChanges(retained, contribution);
}

export function createDrizzleChangeTrailAggregateWriter(db: Database): ChangeTrailAggregateWriter {
  let cursor: { thread_id: string; turn_key: string } | undefined;
  const writer: ChangeTrailAggregateWriter = {
    async record(input) {
      return runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        const committed: CommittedChangeTrailProjection[] = [];
        const trails = [...input.trails].sort((left, right) =>
          trailIdForOwner(left.owner).localeCompare(trailIdForOwner(right.owner)),
        );
        // Every transaction acquires aggregate locks in trail-id order. This is
        // shared with reconciliation, which can touch turn and shared trails at once.
        for (const trail of trails) {
          const trailId = trailIdForOwner(trail.owner);
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trailId}))`);
        }
        for (const trail of trails) {
          const trailId = trailIdForOwner(trail.owner);
          const [existingShell] = await tx
            .select({ version: changeTrailShells.version })
            .from(changeTrailShells)
            .where(eq(changeTrailShells.id, trailId))
            .limit(1);
          if (input.settlementRefinement?.currentVersion && !existingShell) {
            throw new Error(`Cannot refine missing change trail ${trailId}`);
          }
          const version = input.settlementRefinement?.currentVersion
            ? (existingShell?.version as number)
            : (existingShell?.version ?? 0) + 1;
          if (!input.settlementRefinement?.currentVersion) {
            await tx
              .insert(changeTrailShells)
              .values({
                id: trailId,
                threadId: trail.owner.threadId as ThreadId,
                turnId: trail.owner.kind === "turn" ? (trail.owner.turnId as TurnId) : null,
                ownerKind: trail.owner.kind,
                version,
                changeCount: trail.counts.changes,
                documentCount: trail.counts.documents,
              })
              .onConflictDoNothing();
          }

          const existingDetails = await tx
            .select({
              documentId: changeTrailDocumentDetails.documentId,
              documentTitle: changeTrailDocumentDetails.documentTitle,
              changes: changeTrailDocumentDetails.changes,
            })
            .from(changeTrailDocumentDetails)
            .where(eq(changeTrailDocumentDetails.trailId, trailId));
          const refinedPushIds = new Set<string | null>(input.settlementRefinement?.pushIds ?? []);
          const incomingPushIds = new Set([
            ...trail.changes.map((change) => change.pushId),
            ...refinedPushIds,
          ]);
          const persistedChanges = existingDetails.flatMap(
            (detail) => detail.changes as TrailChangeV1[],
          );
          const persistedPushChanges = persistedChanges.filter((change) =>
            incomingPushIds.has(change.pushId),
          );
          const incomingKeys = new Set(trail.changes.map(canonicalChangeKey));
          const refinementIsComplete = input.settlementRefinement
            ? true
            : persistedPushChanges.length === incomingKeys.size &&
              persistedPushChanges.every((change) => incomingKeys.has(canonicalChangeKey(change)));
          const retiredPushIds = new Set<string | null>(
            input.settlementRefinement?.retiredPushIds ?? [],
          );
          const replacement = input.settlementRefinement
            ? refinePushChanges(
                persistedPushChanges.filter((change) => !retiredPushIds.has(change.pushId)),
                trail.changes,
              )
            : trail.changes;
          const changes = input.settlementRefinement?.currentVersion
            ? refinementIsComplete
              ? mergeTrailChanges(
                  persistedChanges.filter((change) => !incomingPushIds.has(change.pushId)),
                  replacement,
                )
              : persistedChanges
            : mergeTrailChanges(
                input.settlementRefinement
                  ? persistedChanges.filter((change) => !refinedPushIds.has(change.pushId))
                  : persistedChanges,
                replacement,
              );

          const pushIds = [
            ...new Set(
              changes.flatMap((change) =>
                change.pushId !== null && /^\d+$/.test(change.pushId)
                  ? [Number(change.pushId)]
                  : [],
              ),
            ),
          ];
          const admitters =
            pushIds.length === 0
              ? []
              : await tx
                  .select({ id: pushLineage.id, pushedByUserId: pushLineage.pushedByUserId })
                  .from(pushLineage)
                  .where(inArray(pushLineage.id, pushIds));
          const admitterByPushId = new Map(
            admitters.map((row) => [String(row.id), row.pushedByUserId ?? null]),
          );
          const documentIds = new Set([
            ...existingDetails.map((detail) => detail.documentId),
            ...trail.changes.flatMap((change) => (change.documentId ? [change.documentId] : [])),
          ]);
          for (const documentId of documentIds) {
            const documentTitle =
              input.documentTitles.get(documentId) ??
              existingDetails.find((detail) => detail.documentId === documentId)?.documentTitle ??
              "Untitled document";
            const [occurrence] = await tx
              .insert(changeTrailDocumentOccurrences)
              .values({ trailId, documentId, projectionRevision: 1 })
              .onConflictDoUpdate({
                target: [
                  changeTrailDocumentOccurrences.trailId,
                  changeTrailDocumentOccurrences.documentId,
                ],
                set: {
                  projectionRevision: sql`${changeTrailDocumentOccurrences.projectionRevision} + 1`,
                },
              })
              .returning({
                projectionRevision: changeTrailDocumentOccurrences.projectionRevision,
              });
            if (!occurrence) throw new Error("Failed to advance change-trail projection revision");
            const documentChanges = changes.filter((change) => change.documentId === documentId);
            committed.push({
              trailId,
              owner: trail.owner,
              documentId,
              projectionRevision: occurrence.projectionRevision,
              changes: documentChanges.map((change) => ({
                ...change,
                admittedByUserId:
                  change.pushId === null ? null : (admitterByPushId.get(change.pushId) ?? null),
              })),
            });
            if (documentChanges.length === 0) {
              await tx
                .delete(changeTrailDocumentDetails)
                .where(
                  and(
                    eq(changeTrailDocumentDetails.trailId, trailId),
                    eq(changeTrailDocumentDetails.documentId, documentId),
                  ),
                );
              continue;
            }
            const wordDelta = trailWordDelta(documentChanges);
            await tx
              .insert(changeTrailDocumentDetails)
              .values({
                trailId,
                documentId,
                documentTitle,
                ...wordDelta,
                changes: documentChanges,
              })
              .onConflictDoUpdate({
                target: [changeTrailDocumentDetails.trailId, changeTrailDocumentDetails.documentId],
                set: {
                  documentTitle,
                  ...wordDelta,
                  changes: documentChanges,
                  updatedAt: new Date(),
                },
              });
          }

          const details = await tx
            .select({
              documentId: changeTrailDocumentDetails.documentId,
              documentTitle: changeTrailDocumentDetails.documentTitle,
              wordsAdded: changeTrailDocumentDetails.wordsAdded,
              wordsRemoved: changeTrailDocumentDetails.wordsRemoved,
              changes: changeTrailDocumentDetails.changes,
            })
            .from(changeTrailDocumentDetails)
            .where(eq(changeTrailDocumentDetails.trailId, trailId));
          const allChanges = details.flatMap((detail) => detail.changes as TrailChangeV1[]);
          const documents = details
            .map((detail) => ({ documentId: detail.documentId, title: detail.documentTitle }))
            .sort((left, right) => left.documentId.localeCompare(right.documentId));
          const hasWordData = details.every(
            (detail) => detail.wordsAdded !== null && detail.wordsRemoved !== null,
          );
          await tx
            .update(changeTrailShells)
            .set({
              version,
              state: "building",
              settledAt: null,
              changeCount: allChanges.length,
              documentCount: details.length,
              documents,
              wordsAdded: hasWordData
                ? details.reduce((sum, detail) => sum + (detail.wordsAdded ?? 0), 0)
                : null,
              wordsRemoved: hasWordData
                ? details.reduce((sum, detail) => sum + (detail.wordsRemoved ?? 0), 0)
                : null,
              updatedAt: new Date(),
            })
            .where(eq(changeTrailShells.id, trailId));
          const counts = {
            changeCount: allChanges.length,
            documentCount: details.length,
          };
          if (input.settlementRefinement?.currentVersion) {
            await tx
              .update(changeTrailDeliveryOutbox)
              .set(counts)
              .where(
                and(
                  eq(changeTrailDeliveryOutbox.trailId, trailId),
                  eq(changeTrailDeliveryOutbox.version, version),
                  eq(changeTrailDeliveryOutbox.eventKind, "updated"),
                ),
              );
          } else {
            await tx.insert(changeTrailDeliveryOutbox).values({
              eventId: deterministicUuid(`change-trail-event:${trailId}:${version}:updated`),
              threadId: trail.owner.threadId as ThreadId,
              trailId,
              version,
              eventKind: "updated",
              ...counts,
            });
          }
        }
        return committed;
      });
    },
    async replacePushContributions(contributions, context) {
      const byTrail = new Map<
        string,
        { owner: NormalizedTrail["owner"]; changes: TrailChangeV1[] }
      >();
      const documentTitles = new Map<string, string>();
      for (const { replacement, retire } of contributions) {
        for (const [documentId, title] of replacement.documentTitles) {
          documentTitles.set(documentId, title);
        }
        for (const { owner, changes } of replacement.targets) {
          const key = trailIdForOwner(owner);
          const target = byTrail.get(key) ?? { owner, changes: [] };
          if (!retire) target.changes.push(...changes);
          byTrail.set(key, target);
        }
      }
      return writer.record({
        trails: [...byTrail.values()].map(({ owner, changes }) => ({
          owner,
          changes,
          counts: {
            changes: changes.length,
            documents: new Set(changes.map((change) => change.documentId)).size,
          },
        })),
        documentTitles,
        settlementRefinement: {
          pushIds: contributions.map(({ pushId }) => pushId),
          currentVersion: context.refineCurrentVersion,
          retiredPushIds: contributions.flatMap(({ pushId, retire }) => (retire ? [pushId] : [])),
        },
      });
    },
    async reopenOwners(owners) {
      const tx = currentDrizzleDb(db);
      const sortedOwners = [
        ...new Map(owners.map((owner) => [trailIdForOwner(owner), owner])).entries(),
      ].sort(([left], [right]) => left.localeCompare(right));
      for (const [trailId] of sortedOwners) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${trailId}))`);
      }
      for (const [trailId, owner] of sortedOwners) {
        const [reopened] = await tx
          .update(changeTrailShells)
          .set({
            state: "building",
            version: sql`${changeTrailShells.version} + 1`,
            settledAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(changeTrailShells.id, trailId), eq(changeTrailShells.state, "settled")))
          .returning({
            version: changeTrailShells.version,
            changeCount: changeTrailShells.changeCount,
            documentCount: changeTrailShells.documentCount,
          });
        if (!reopened) continue;
        await tx
          .insert(changeTrailDeliveryOutbox)
          .values({
            eventId: deterministicUuid(`change-trail-event:${trailId}:${reopened.version}:updated`),
            threadId: owner.threadId as ThreadId,
            trailId,
            version: reopened.version,
            eventKind: "updated",
            changeCount: reopened.changeCount,
            documentCount: reopened.documentCount,
          })
          .onConflictDoNothing();
      }
    },
    async reconcileTerminalOwners() {
      cursor = await reconcileTerminalOwners(db, cursor);
    },
  };
  return writer;
}

/** Reconciles one durable owner cut, retaining an observable settling version. */
async function reconcileTerminalOwners(
  db: Database,
  cursor?: { thread_id: string; turn_key: string },
) {
  return runInRootDrizzleTransaction(db, async () => {
    const tx = currentDrizzleDb(db);
    const page = (after: typeof cursor) =>
      tx.execute(sql`
      SELECT * FROM (
        SELECT shell.id, owner.thread_id, owner.id AS turn_key, owner.id AS turn_id
        FROM turns owner LEFT JOIN change_trail_shells shell ON shell.turn_id = owner.id
          AND shell.thread_id = owner.thread_id AND shell.owner_kind = 'turn'
        WHERE (shell.state <> 'settled' OR EXISTS (
          SELECT 1 FROM change_trail_dirty_log signal
          WHERE signal.thread_id = owner.thread_id AND signal.turn_id = owner.id
        )) AND (shell.id IS NOT NULL OR owner.status IN ('complete', 'cancelled', 'error'))
        UNION
        SELECT shell.id, candidates.thread_id, '00000000-0000-0000-0000-000000000000'::uuid AS turn_key, NULL::uuid AS turn_id
        FROM (
          SELECT thread_id FROM change_trail_dirty_log WHERE turn_id IS NULL
          UNION SELECT thread_id FROM change_trail_shells WHERE owner_kind = 'shared' AND state <> 'settled'
        ) candidates LEFT JOIN change_trail_shells shell
          ON shell.thread_id = candidates.thread_id AND shell.owner_kind = 'shared'
      ) candidates
      ${after ? sql`WHERE (thread_id, turn_key) > (${after.thread_id}::uuid, ${after.turn_key}::uuid)` : sql``}
      ORDER BY thread_id, turn_key LIMIT 100
    `);
    let result = await page(cursor);
    if (result.length === 0 && cursor) result = await page(undefined);
    const owners = (
      result as unknown as Array<{
        id: string | null;
        thread_id: string;
        turn_id: string | null;
        turn_key: string;
      }>
    ).map((row) => ({
      ...row,
      id:
        row.id ??
        trailIdForOwner(
          row.turn_id
            ? {
                kind: "turn",
                threadId: row.thread_id,
                turnId: row.turn_id,
              }
            : { kind: "shared", threadId: row.thread_id, turnId: null },
        ),
    }));
    if (owners.length === 0) return undefined;
    const ids = owners.map((owner) => owner.id).sort();
    for (const id of ids) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    const newTurns = owners.filter((owner) => owner.turn_id);
    if (newTurns.length)
      await tx
        .insert(changeTrailShells)
        .values(
          newTurns.map((owner) => ({
            id: owner.id,
            threadId: owner.thread_id as ThreadId,
            turnId: owner.turn_id as TurnId,
            ownerKind: "turn" as const,
            changeCount: 0,
            documentCount: 0,
          })),
        )
        .onConflictDoNothing();
    // DELETE and readiness share a snapshot. Later commits, even lower sequences,
    // remain signals; rollback restores consumption along with shell/outbox writes.
    const cuts = await tx.execute(sql`
      WITH consumed AS (
        DELETE FROM change_trail_dirty_log signal WHERE ${sql.join(
          owners.map(
            (owner) =>
              sql`(signal.thread_id = ${owner.thread_id}::uuid AND signal.turn_id IS NOT DISTINCT FROM ${owner.turn_id}::uuid)`,
          ),
          sql` OR `,
        )}
        RETURNING thread_id, turn_id, seq
      )
      SELECT shell.*,
        EXISTS (SELECT 1 FROM consumed WHERE consumed.thread_id = shell.thread_id
          AND consumed.turn_id IS NOT DISTINCT FROM shell.turn_id) AS dirty,
        CASE WHEN shell.owner_kind = 'turn' THEN owner.status IN ('complete', 'cancelled', 'error')
          ELSE NOT EXISTS (SELECT 1 FROM turns WHERE turns.thread_id = shell.thread_id
            AND turns.status NOT IN ('complete', 'cancelled', 'error')) END AS terminal,
        NOT EXISTS (
          SELECT 1 FROM branch_write_journal journal
          CROSS JOIN LATERAL change_trail_owners('{}', ARRAY[journal.id]) affected
          WHERE journal.status = 'rollback_pending' AND affected.thread_id = shell.thread_id
            AND affected.turn_id IS NOT DISTINCT FROM shell.turn_id
        ) AND NOT EXISTS (
          SELECT 1 FROM branch_push_settlement_outbox pending
          CROSS JOIN LATERAL change_trail_owners('{}', '{}', ARRAY[pending.push_id]) affected
          WHERE pending.state = 'pending' AND affected.thread_id = shell.thread_id
            AND affected.turn_id IS NOT DISTINCT FROM shell.turn_id
        ) AS ready
      FROM change_trail_shells shell JOIN threads thread ON thread.id = shell.thread_id
      LEFT JOIN turns owner ON owner.id = shell.turn_id
      WHERE shell.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY shell.id
    `);
    for (const cut of cuts as unknown as Array<{
      id: string;
      thread_id: ThreadId;
      state: "building" | "settling" | "settled";
      version: number;
      dirty: boolean;
      terminal: boolean;
      ready: boolean;
      change_count: number;
      document_count: number;
      documents: Array<{ documentId: string; title: string }>;
      words_added: number | null;
      words_removed: number | null;
    }>) {
      let state = cut.state;
      let version = cut.version;
      const transition = async (next: typeof state) => {
        state = next;
        version += 1;
        const settled = next === "settled";
        await tx
          .update(changeTrailShells)
          .set({
            state,
            version,
            settledAt: settled ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(changeTrailShells.id, cut.id));
        const eventKind = settled ? ("settled" as const) : ("updated" as const);
        await tx
          .insert(changeTrailDeliveryOutbox)
          .values({
            eventId: deterministicUuid(`change-trail-event:${cut.id}:${version}:${eventKind}`),
            threadId: cut.thread_id,
            trailId: cut.id,
            version,
            eventKind,
            changeCount: cut.change_count,
            documentCount: cut.document_count,
            ...(settled
              ? {
                  documents: cut.documents,
                  wordsAdded: cut.words_added,
                  wordsRemoved: cut.words_removed,
                }
              : {}),
          })
          .onConflictDoNothing();
      };
      if (state === "settled" && cut.dirty) {
        await transition("building");
      }
      if (!cut.terminal) continue;
      // Never collapse building -> settling -> settled into one polling pass.
      if (state === "building") await transition("settling");
      else if (state === "settling" && cut.ready) await transition("settled");
    }
    const last = owners.at(-1);
    return last ? { thread_id: last.thread_id, turn_key: last.turn_key } : undefined;
  });
}
