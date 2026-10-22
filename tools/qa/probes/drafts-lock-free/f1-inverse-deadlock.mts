/**
 * Final-gate F1, the deadlock arm: a model Undo and a correctly ordered journal append bound to
 * the same Work. The Undo's nested journal seam asks its grant whether it covers the document
 * while the Undo holds its document lock; there the rival append starts on its own connection.
 * The Undo already holds the Work row (its seam boundary took it first), so the rival waits on
 * that row, never on the document, and both commit. Before the fix the Undo took the Work row
 * last and PostgreSQL broke the cycle with `40P01`.
 */
import assert from "node:assert/strict";
import { runWithEditConfirmation } from "../../../../apps/server/server/shared/edit-confirmation.ts";
import { seedModelLiveWrite, workGrant } from "./f1-inverse-grant.mts";
import { independently, observe, type Probe, settled } from "./harness.mts";

export const f1InverseDeadlock: Probe = {
  name: "f1-inverse-deadlock",
  decision: "final-gate F1, D17",
  expected: "the rival append waits on the Work row the Undo holds, then both commit; no 40P01",
  async run(harness) {
    const seeded = await seedModelLiveWrite(harness, "grant-deadlock");
    let rival: ReturnType<typeof settled<number>> | undefined;
    let waiting: string[] = [];
    const grant = workGrant(harness, seeded.workId);
    let first = true;
    grant.covers = async () => {
      if (first) {
        first = false;
        rival = settled(
          independently(() =>
            runWithEditConfirmation(workGrant(harness, seeded.workId), () =>
              harness.persistence.journal.append(seeded.documentId, new Uint8Array([0, 0]), {
                origin: "system",
                seq: 0,
              }),
            ),
          ),
        );
        // Held off by a lock the Undo owns: the Work row, before any document lock.
        waiting = await harness.waitForLockWaiter(/works|advisory/);
      }
      return true;
    };
    const undo = await settled(runWithEditConfirmation(grant, seeded.undo));
    const competing = rival ? await rival : undefined;
    observe("undo and rival append", {
      rivalWaitedOn: waiting,
      undo: undo.ok ? { ok: true, status: undo.value.status } : undo,
      rival: competing?.ok ? { ok: true } : competing,
    });
    assert.ok(
      waiting.some((query) => /works/.test(query)),
      "the rival must wait on the Work row, not the document",
    );
    assert.ok(undo.ok && undo.value.status === "success");
    assert.ok(competing?.ok, "the rival append must commit, not deadlock");
  },
};
