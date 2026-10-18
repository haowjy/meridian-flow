/**
 * Durable readback of one document branch for the lock-free drafts probes: reads the branch
 * through the server's own `readBranchAt` (one statement: row, checkpoint and tail) and prints its
 * fences, its tail, its materialized text and a hash of its state.
 *
 *   pnpm exec tsx tools/qa/branch-readback.ts <branchId> [--db <url>]
 *
 * Without `--db` it reads this worktree's dev database.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createDb } from "@meridian/database";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { readBranchAt } from "../../apps/server/server/domains/collab/adapters/drizzle-branch-storage.ts";
import { materializeBranchRead } from "../../apps/server/server/domains/collab/domain/branch-store.ts";
import { applyDevEnvToProcess } from "../dev/lib/dev-env";

function parseArgs(argv: readonly string[]): { branchId: string; db?: string } {
  const [branchId, ...rest] = argv;
  if (!branchId || branchId.startsWith("--")) {
    throw new Error("usage: tsx tools/qa/branch-readback.ts <branchId> [--db <url>]");
  }
  const at = rest.indexOf("--db");
  const db = at >= 0 ? rest[at + 1] : undefined;
  if (at >= 0 && !db) throw new Error("--db needs a database URL");
  return { branchId, ...(db ? { db } : {}) };
}

/** The writer-visible text: each block's characters, one block per line. */
function visibleText(node: Y.XmlFragment | Y.XmlElement): string {
  return node
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText) {
        return (child.toDelta() as { insert: unknown }[])
          .map((op) => (typeof op.insert === "string" ? op.insert : ""))
          .join("");
      }
      return child instanceof Y.XmlElement ? visibleText(child) : "";
    })
    .join("\n");
}

function tailClients(update: Uint8Array): number[] {
  return [...new Set(Y.decodeUpdate(update).structs.map((struct) => struct.id.client))];
}

async function main(): Promise<void> {
  const { branchId, db: url } = parseArgs(process.argv.slice(2));
  if (!url) applyDevEnvToProcess(resolve(import.meta.dirname, "../.."));
  const databaseUrl = url ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("No DATABASE_URL: pass --db or run inside a worktree");
  const db = createDb(databaseUrl, { max: 1 });
  try {
    const read = await readBranchAt(db, branchId);
    if (!read) throw new Error(`Branch ${branchId} does not exist`);
    const doc = materializeBranchRead(read);
    const state = Y.encodeStateAsUpdate(doc);
    const { branch } = read;
    const report = {
      branchId,
      kind: branch.kind,
      status: branch.status,
      lifecycle: branch.lifecycle,
      revision: branch.revision,
      checkpointRevision: branch.checkpointRevision,
      checkpointSeq: branch.checkpointSeq,
      generation: branch.generation,
      hasEffect: branch.hasEffect,
      tail: read.tail.map((row) => ({
        id: row.id,
        source: row.source,
        bytes: row.update.byteLength,
        clients: tailClients(row.update),
      })),
      stateBytes: state.byteLength,
      stateSha256: createHash("sha256").update(state).digest("hex"),
      text: visibleText(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
    };
    doc.destroy();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
