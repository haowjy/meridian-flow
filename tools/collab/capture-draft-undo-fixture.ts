#!/usr/bin/env tsx
/** Captures draft-review Yjs rows as base64 JSON fixtures for runtime attribution tests. */
import postgres from "postgres";

type SequenceArg = { name: string; draftId: string };

type DraftUpdateRow = {
  id: number;
  actor_turn_id: string | null;
  actor_user_id: string | null;
  update_data: Uint8Array;
};

const args = parseArgs(process.argv.slice(2));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!args.documentId) throw new Error("--document-id is required");
if (args.sequences.length === 0)
  throw new Error("at least one --sequence name:draft-id is required");

const sql = postgres(databaseUrl, { max: 1 });
try {
  const [checkpoint] = await sql<{ state: Uint8Array }[]>`
    select state
    from document_yjs_checkpoints
    where document_id = ${args.documentId}
    order by id desc
    limit 1
  `;
  if (!checkpoint) throw new Error(`No checkpoint found for document ${args.documentId}`);

  const sequences: Record<string, unknown[]> = {};
  for (const sequence of args.sequences) {
    const rows = await sql<DraftUpdateRow[]>`
      select id, actor_turn_id, actor_user_id, update_data
      from document_yjs_draft_updates
      where draft_id = ${sequence.draftId}
      order by id asc
    `;
    sequences[sequence.name] = rows.map((row) => ({
      id: row.id,
      actorTurnId: row.actor_turn_id,
      ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
      updateB64: Buffer.from(row.update_data).toString("base64"),
    }));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        description: "Captured draft undo runtime fixture.",
        liveCheckpointB64: Buffer.from(checkpoint.state).toString("base64"),
        sequences,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await sql.end();
}

function parseArgs(argv: string[]): { documentId: string | null; sequences: SequenceArg[] } {
  const parsed: { documentId: string | null; sequences: SequenceArg[] } = {
    documentId: null,
    sequences: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--document-id") {
      parsed.documentId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--sequence") {
      const value = requireValue(argv, ++index, arg);
      const separator = value.indexOf(":");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("--sequence must be name:draft-id");
      }
      parsed.sequences.push({
        name: value.slice(0, separator),
        draftId: value.slice(separator + 1),
      });
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
