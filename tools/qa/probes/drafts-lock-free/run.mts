/**
 * Runs the lock-free drafts seam probes (decision D21) against one scratch database:
 *
 *   pnpm exec tsx tools/qa/probes/drafts-lock-free/run.mts [probe ...] [--db <url>] [--keep]
 *
 * Without `--db` it creates `lfd_probe_*` on the local dev Postgres, runs the committed migration
 * chain, and drops it afterwards (`--keep` leaves it for inspection). Each probe prints its
 * observations and `PASS` or `FAIL`; the exit code is the number of failed probes. The index of
 * probes, decisions and expected output is `docs/qa/drafts-lock-free-probes.md`.
 */

import { appendBetweenRows } from "./append-between-rows.mts";
import { appendNovelty } from "./append-novelty.mts";
import { appendRollbackScope } from "./append-rollback-scope.mts";
import { appendTailOrder } from "./append-tail-order.mts";
import { archiveInFlightAppend } from "./archive-in-flight-append.mts";
import { clientResync } from "./client-resync.mts";
import { d12CreateDuringArchive } from "./d12-create-during-archive.mts";
import { d12PullBeforeArchive } from "./d12-pull-before-archive.mts";
import { d13CandidateDisposal } from "./d13-candidate-disposal.mts";
import { d13RecaptureReleasesRow } from "./d13-recapture-releases-row.mts";
import { d22ConcurrentUndo } from "./d22-concurrent-undo.mts";
import { d22RetractedPeerPull } from "./d22-retracted-peer-pull.mts";
import { d23ArchivedDraftRebases } from "./d23-archived-draft-rebases.mts";
import { effectProjection } from "./effect-projection.mts";
import { effectWatermarkSweep } from "./effect-watermark-sweep.mts";
import { f1InverseDeadlock } from "./f1-inverse-deadlock.mts";
import { f1InverseGrant } from "./f1-inverse-grant.mts";
import { createScratchDatabase, openHarness, type Probe } from "./harness.mts";
import { liveDuplicateFrame } from "./live-duplicate-frame.mts";
import { migrationOnline } from "./migration-online.mts";
import { coldLoadCommit, droppedDelivery, readOnlyHandshake } from "./room-enrollment.mts";
import { twoProcessCompaction, twoProcessFold, twoProcessFrames } from "./two-process-frames.mts";

const PROBES: readonly Probe[] = [
  d12PullBeforeArchive,
  d12CreateDuringArchive,
  d13RecaptureReleasesRow,
  d13CandidateDisposal,
  d22RetractedPeerPull,
  f1InverseGrant,
  f1InverseDeadlock,
  d22ConcurrentUndo,
  d23ArchivedDraftRebases,
  twoProcessFrames,
  twoProcessFold,
  twoProcessCompaction,
  coldLoadCommit,
  droppedDelivery,
  readOnlyHandshake,
  // Phase 4: CRDT-native appends (design phase4-crdt-appends §9).
  appendTailOrder,
  appendBetweenRows,
  appendNovelty,
  appendRollbackScope,
  archiveInFlightAppend,
  effectProjection,
  effectWatermarkSweep,
  migrationOnline,
  clientResync,
  // A draft's review while live is ahead of its last pull (owner report, live-edit-review).
  // A live update relayed onto a second socket of its room is journaled once (#946).
  liveDuplicateFrame,
];

function parseArgs(argv: readonly string[]) {
  const names: string[] = [];
  let db: string | undefined;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") {
      db = argv[index + 1];
      index += 1;
      if (!db) throw new Error("--db needs a database URL");
    } else if (arg === "--keep") keep = true;
    else if (arg) names.push(arg);
  }
  const unknown = names.filter((name) => !PROBES.some((probe) => probe.name === name));
  if (unknown.length)
    throw new Error(
      `Unknown probe ${unknown.join(", ")}; one of ${PROBES.map((p) => p.name).join(", ")}`,
    );
  return {
    probes: names.length ? PROBES.filter((probe) => names.includes(probe.name)) : PROBES,
    db,
    keep,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const scratch = args.db ? undefined : await createScratchDatabase();
  const url = args.db ?? scratch?.url;
  if (!url) throw new Error("No database");
  console.log(`database ${new URL(url).pathname.slice(1)}`);
  let failed = 0;
  try {
    for (const probe of args.probes) {
      console.log(`\n${probe.name} (${probe.decision})\n  expect: ${probe.expected}`);
      const harness = await openHarness(url);
      try {
        await probe.run(harness);
        console.log(`PASS ${probe.name}`);
      } catch (cause) {
        failed += 1;
        console.log(`FAIL ${probe.name}`);
        console.log(cause);
      } finally {
        await harness.close();
      }
    }
  } finally {
    if (scratch && !args.keep) await scratch.drop();
    else if (scratch) console.log(`\nkept ${url}`);
  }
  console.log(`\n${args.probes.length - failed}/${args.probes.length} probes passed`);
  return failed;
}

main().then(
  (failed) => {
    process.exitCode = failed;
  },
  (cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  },
);
