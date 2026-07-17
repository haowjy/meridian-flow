/**
 * Summarize Yjs journal update rows without reconstructing manuscript content.
 *
 * File: pnpm tsx packages/yjs-inspect/examples/decode-journal.ts updates.txt
 * Stdin: cat updates.txt | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
 * Database:
 * psql "$DATABASE_URL" -X -A -t -c "SELECT encode(update_data, 'hex') FROM document_yjs_updates WHERE document_id = '<document-id>' ORDER BY id, batch_ordinal" | pnpm tsx packages/yjs-inspect/examples/decode-journal.ts
 *
 * Input may be one hex row per line, `sequence<TAB>hex`, psql expanded output
 * containing `update_hex | ...`, or an explicit `base64:<data>` row.
 */

import { readFile } from "node:fs/promises";
import { summarizeUpdate } from "../src/index.js";

function decodeRow(line: string): Uint8Array | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const expandedHex = trimmed.match(/^update_hex\s*\|\s*([0-9a-f]+)$/i)?.[1];
  const tabularHex = trimmed.match(/^\d+\s+([0-9a-f]+)$/i)?.[1];
  const prefixedHex = trimmed.match(/^hex:([0-9a-f]+)$/i)?.[1];
  const bareHex = trimmed.match(/^[0-9a-f]+$/i)?.[0];
  const hex = expandedHex ?? tabularHex ?? prefixedHex ?? bareHex;
  if (hex) {
    if (hex.length % 2 !== 0) throw new Error(`Odd-length hex row: ${trimmed}`);
    return Uint8Array.from(Buffer.from(hex, "hex"));
  }

  const base64 = trimmed.match(/^base64:([A-Za-z0-9+/]+={0,2})$/)?.[1];
  return base64 ? Uint8Array.from(Buffer.from(base64, "base64")) : null;
}

interface JournalRow {
  id: string;
  update: Uint8Array;
}

function decodeRows(input: string): JournalRow[] {
  const rows: JournalRow[] = [];
  const unrecognized: string[] = [];
  let expandedRecord: string | undefined;
  let expandedId: string | undefined;

  input.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const record = trimmed.match(/^-\[ RECORD (\d+) \]-+/)?.[1];
    if (record) {
      expandedRecord = record;
      expandedId = undefined;
      return;
    }

    const id = trimmed.match(/^id\s*\|\s*(\S+)$/i)?.[1];
    if (id) {
      expandedId = id;
      return;
    }

    if (/^update_hex\s*\|/i.test(trimmed)) {
      const update = decodeRow(trimmed);
      const rowId = expandedId ?? expandedRecord ?? `line ${index + 1}`;
      if (update) rows.push({ id: rowId, update });
      else unrecognized.push(`${rowId} (line ${index + 1})`);
      return;
    }

    // Other expanded-output fields are context for an update_hex row.
    if (/^[a-z_]+\s*\|/i.test(trimmed)) return;

    const update = decodeRow(trimmed);
    if (update) {
      const explicitId = trimmed.match(/^(\d+)\s+/)?.[1];
      rows.push({ id: explicitId ?? String(rows.length + 1), update });
      return;
    }

    const explicitId = trimmed.match(/^(\d+)\s+/)?.[1];
    unrecognized.push(explicitId ? `${explicitId} (line ${index + 1})` : `line ${index + 1}`);
  });

  if (unrecognized.length > 0) {
    throw new Error(`Unrecognized input row ids: ${unrecognized.join(", ")}`);
  }
  return rows;
}

const file = process.argv[2];
const input = file
  ? await readFile(file, "utf8")
  : await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });

const rows = decodeRows(input);
if (rows.length === 0) throw new Error("No hex or base64 update rows found");

let totalBytes = 0;
let totalStructs = 0;
let totalDeleteRanges = 0;
let totalDeletedLength = 0;
let noopRows = 0;

rows.forEach((row) => {
  const summary = summarizeUpdate(row.update);
  totalBytes += summary.bytes;
  totalStructs += summary.structCount;
  totalDeleteRanges += summary.deleteRangeCount;
  totalDeletedLength += summary.deletedLength;
  if (summary.isNoop) noopRows += 1;
  console.log(
    `row=${row.id} bytes=${summary.bytes} structs=${summary.structCount} deleteRanges=${summary.deleteRangeCount} deleted=${summary.deletedLength} noop=${summary.isNoop} spans=${summary.spansKey || "-"} hash=${summary.updateHash}`,
  );
});

console.log(
  `totals rows=${rows.length} bytes=${totalBytes} structs=${totalStructs} deleteRanges=${totalDeleteRanges} deleted=${totalDeletedLength} noops=${noopRows}`,
);
